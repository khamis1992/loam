'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import {
  AppWindow, AudioLines, BarChart3, Bot, Box, Compass, ChevronRight,
  Chrome, FileText, Gamepad2, Image as ImageIcon, Monitor,
  NotebookTabs, PanelTop, Play, Presentation, RefreshCw, Smartphone, Table2,
  Video, Wand2, X, ArrowUp, type LucideIcon,
} from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { BUILD_GOALS, CREATE_GOALS, type StudioGoal, type StudioGoalIcon } from './studioGoals';
import { GameGallery, VideoGallery } from './PromoGoalGalleries';

const ICONS: Record<StudioGoalIcon, LucideIcon> = {
  website: AppWindow,
  desktop: Monitor,
  widget: PanelTop,
  automation: Bot,
  notebook: NotebookTabs,
  mobile: Smartphone,
  chrome: Chrome,
  safari: Compass,
  game: Gamepad2,
  slides: Presentation,
  document: FileText,
  spreadsheet: Table2,
  visualization: BarChart3,
  image: ImageIcon,
  video: Video,
  audio: AudioLines,
};

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label={t('Close')}
      className="rounded-control p-1.5 text-text-tertiary hover:bg-fill-hover hover:text-text-primary"
    >
      <X className="size-4" />
    </button>
  );
}

function GoalPreview({ goal, wide = false }: { goal: StudioGoal; wide?: boolean }) {
  return (
    <span className={clsx(
      'relative block overflow-hidden rounded-control bg-fill-tsp',
      wide ? 'h-[92px] w-[150px]' : 'h-[100px] w-full',
    )}>
      <Image
        src={`/studio-goals/${goal.id}.png`}
        alt=""
        fill
        sizes={wide ? '150px' : '(max-width: 768px) 50vw, 180px'}
        className="object-cover"
        unoptimized
      />
    </span>
  );
}

export function StudioPickerDialog({
  kind,
  onClose,
  onSelect,
}: {
  kind: 'build' | 'create';
  onClose: () => void;
  onSelect: (goal: StudioGoal) => void;
}) {
  useEscape(onClose);
  const goals = kind === 'build' ? BUILD_GOALS : CREATE_GOALS;
  const title = kind === 'build' ? 'Build' : 'Create';
  const website = kind === 'build' ? goals[0] : null;
  const gridGoals = kind === 'build' ? goals.slice(1) : goals;

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/10 p-4" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t(title)}
        className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-[20px] border border-border-main bg-bg-menu p-4 shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">{t(title)}</h2>
          <CloseButton onClose={onClose} />
        </header>

        {website && (
          <button
            type="button"
            onClick={() => onSelect(website)}
            data-testid={`studio-goal-${website.id}`}
            className="mb-3 flex w-full items-center justify-between rounded-card bg-fill-tsp p-4 text-start hover:bg-fill-hover"
          >
            <span>
              <span className="flex items-center gap-1 text-sm font-medium text-text-primary">
                {t(website.label)} <ChevronRight className="size-3.5 rtl:rotate-180" />
              </span>
              <span className="mt-1 block max-w-md text-xs leading-5 text-text-tertiary">{t(website.description ?? '')}</span>
            </span>
            <GoalPreview goal={website} wide />
          </button>
        )}

        {kind === 'create' ? (
          <div className="flex flex-col gap-4">
            {(['Document', 'Media'] as const).map((section) => (
              <section key={section}>
                <h3 className="mb-2 text-xs text-text-tertiary">{t(section)}</h3>
                <div className={clsx('grid gap-3', section === 'Document' ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-2 sm:grid-cols-3')}>
                  {gridGoals.filter((goal) => goal.section === section).map((goal) => (
                    <button
                      key={goal.id}
                      type="button"
                      onClick={() => onSelect(goal)}
                      disabled={goal.disabled}
                      title={goal.disabled ? t('Coming soon') : undefined}
                      className="rounded-card text-center text-xs text-text-primary hover:bg-fill-hover disabled:cursor-not-allowed disabled:opacity-45"
                      data-testid={`studio-goal-${goal.id}`}
                    >
                      <GoalPreview goal={goal} />
                      <span className="mt-2 block pb-1">{goal.disabled ? `${t(goal.label)} · ${t('Soon')}` : t(goal.label)}</span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {gridGoals.map((goal) => (
              <button
                key={goal.id}
                type="button"
                onClick={() => onSelect(goal)}
                disabled={goal.disabled}
                title={goal.disabled ? t('Coming soon') : undefined}
                className="rounded-card text-center text-xs text-text-primary hover:bg-fill-hover disabled:cursor-not-allowed disabled:opacity-45"
                data-testid={`studio-goal-${goal.id}`}
              >
                <GoalPreview goal={goal} />
                <span className="mt-2 block pb-1">{goal.disabled ? `${t(goal.label)} · ${t('Soon')}` : t(goal.label)}</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>,
    document.body,
  );
}

export function StudioGoalDialog({
  goal,
  onClose,
  onLaunch,
  initialDraft = '',
}: {
  goal: StudioGoal;
  onClose: () => void;
  onLaunch: (goal: StudioGoal, text: string, options?: { format?: string; chart?: string }) => Promise<void>;
  initialDraft?: string;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(initialDraft);
  const [offset, setOffset] = useState(0);
  const [format, setFormat] = useState(goal.formats?.[0]);
  const [chart, setChart] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEscape(onClose);

  useEffect(() => {
    setDraft(initialDraft);
    setOffset(0);
    setFormat(goal.formats?.[0]);
    setChart(undefined);
  }, [goal, initialDraft]);

  const suggestions = goal.suggestions.map((_, index) => goal.suggestions[(index + offset) % goal.suggestions.length]);
  const launch = async (text: string) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await onLaunch(goal, text.trim(), { format, chart });
      onClose();
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void launch(draft);
  };
  const runAction = () => {
    if (goal.actionRoute) {
      router.push(goal.actionRoute);
      onClose();
    } else if (goal.actionPrompt) {
      void launch(t(goal.actionPrompt));
    }
  };

  const content = (
    <div className={clsx('flex w-full flex-col', goal.fullPage ? 'min-h-full' : '')}>
      <header className={clsx('flex items-center justify-between', goal.fullPage ? (goal.id === 'video' ? 'mb-5' : 'mb-8') : 'mb-4')}>
        <div className={clsx(goal.fullPage && goal.id !== 'video' && 'mx-auto text-center')}>
          {goal.id !== 'video' && <h2 className={clsx('text-text-primary', goal.fullPage ? 'font-serif text-3xl' : 'text-sm font-semibold')}>{t(goal.title)}</h2>}
          {goal.subtitle && <p className="mt-2 text-sm text-text-tertiary">{t(goal.subtitle)}</p>}
        </div>
        <div className="flex items-center gap-1">
          {goal.actionLabel && (
            <button type="button" onClick={runAction} className="me-2 flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary">
              {goal.actionRoute?.includes('design') ? <Wand2 className="size-3.5" /> : goal.actionRoute?.includes('video') ? <Play className="size-3.5" /> : <Box className="size-3.5" />}
              {t(goal.actionLabel)}
            </button>
          )}
          <button
            type="button"
            aria-label={t('Refresh suggestions')}
            onClick={() => setOffset((value) => (value + 1) % goal.suggestions.length)}
            className="rounded-control p-1.5 text-text-tertiary hover:bg-fill-hover"
          >
            <RefreshCw className="size-3.5" />
          </button>
          <CloseButton onClose={onClose} />
        </div>
      </header>

      {goal.id === 'video' ? (
        <VideoGallery onSelect={(title) => setDraft(title)} />
      ) : goal.id === 'game-development' ? (
        <GameGallery suggestions={suggestions} onSelect={(title) => setDraft(title)} />
      ) : (
        <div className={clsx('grid gap-3', goal.id === 'image' ? 'sm:grid-cols-2' : goal.fullPage ? 'sm:grid-cols-4' : 'sm:grid-cols-3')}>
          {suggestions.map((suggestion) => {
            const Icon = ICONS[goal.icon];
            return (
              <button
                key={suggestion}
                type="button"
                onClick={() => setDraft(t(suggestion))}
                className={clsx(
                  'min-h-28 rounded-card border border-border-main bg-bg-menu p-4 text-start hover:bg-fill-hover',
                  goal.id === 'image' && 'flex items-center justify-between gap-3',
                )}
              >
                <span className={clsx('flex flex-col gap-5', goal.id === 'image' && 'gap-2')}>
                  {goal.id !== 'image' && <Icon className="size-4 text-text-secondary" strokeWidth={1.5} />}
                  <span className="text-sm leading-5 text-text-secondary">{t(suggestion)}</span>
                </span>
                {goal.id === 'image' && <Icon className="size-10 shrink-0 text-text-tertiary" strokeWidth={1.2} />}
              </button>
            );
          })}
        </div>
      )}

      {goal.formats && (
        <section className="mt-5">
          <h3 className="mb-2 text-xs font-medium text-text-primary">{t('Choose output format')}</h3>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" role="radiogroup" aria-label={t('Choose output format')}>
            {goal.formats.map((item) => (
              <button
                key={item}
                type="button"
                role="radio"
                aria-checked={format === item}
                onClick={() => setFormat(item)}
                className={clsx(
                  'rounded-card border p-3 text-center text-xs',
                  format === item ? 'border-icon-blue text-icon-blue' : 'border-border-main text-text-secondary',
                )}
              >
                {t(item)}
              </button>
            ))}
          </div>
        </section>
      )}

      {goal.charts && (
        <section className="mt-5">
          <h3 className="mb-2 text-xs font-medium text-text-primary">{t('Preferred charts')}</h3>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {goal.charts.map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={chart === item}
                onClick={() => setChart(chart === item ? undefined : item)}
                className={clsx(
                  'rounded-card border p-3 text-center text-xs',
                  chart === item ? 'border-icon-blue text-icon-blue' : 'border-border-main text-text-secondary',
                )}
              >
                <BarChart3 className="mx-auto mb-2 size-6 text-text-tertiary" strokeWidth={1.2} />
                {t(item)}
              </button>
            ))}
          </div>
        </section>
      )}

      <form onSubmit={submit} className={clsx('rounded-composer border border-border-main bg-bg-menu p-3', goal.fullPage ? 'mt-auto pt-3' : 'mt-4')}>
        <label htmlFor={`studio-goal-input-${goal.id}`} className="sr-only">{t(goal.placeholder)}</label>
        <textarea
          id={`studio-goal-input-${goal.id}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t(goal.placeholder)}
          rows={2}
          className="w-full resize-none bg-transparent px-1 py-1 text-sm text-text-primary outline-none placeholder:text-text-tertiary"
        />
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-control bg-fill-tsp px-2 py-1 text-xs text-icon-blue">
              {(() => { const Icon = ICONS[goal.icon]; return <Icon className="size-3.5" />; })()}
              {t(goal.label)}
            </span>
            {goal.outputType === 'desktop' && (
              <span className="flex items-center gap-1.5 rounded-control border border-border-main px-2 py-1 text-xs text-text-secondary" data-testid="desktop-goal-this-pc">
                <Monitor className="size-3.5" />{t('This PC')}
              </span>
            )}
          </div>
          <button
            type="submit"
            disabled={!draft.trim() || busy}
            aria-label={t('Send')}
            className="rounded-full bg-fill-tsp p-2 text-text-secondary hover:bg-fill-hover disabled:opacity-40"
          >
            <ArrowUp className="size-4" />
          </button>
        </div>
      </form>
    </div>
  );

  if (goal.fullPage) {
    return createPortal(
      <div role="dialog" aria-modal="true" aria-label={t(goal.title)} className="absolute inset-x-0 bottom-0 top-9 z-50 overflow-y-auto bg-bg-main">
        <div className={clsx('mx-auto min-h-full w-full px-6', goal.id === 'video' ? 'max-w-6xl py-6' : 'max-w-4xl pb-6 pt-12')}>{content}</div>
      </div>,
      document.querySelector('main') ?? document.body,
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/10 p-4" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t(goal.title)}
        className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-[20px] border border-border-main bg-bg-menu p-4 shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {content}
      </section>
    </div>,
    document.body,
  );
}
