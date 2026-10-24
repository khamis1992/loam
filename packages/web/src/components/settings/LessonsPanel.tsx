'use client';

/**
 * Settings › Learned lessons (Harness2, task H9).
 *
 * Lists the lessons the agent distilled from user corrections and its own
 * reviews, and lets the user delete one. The rows come from
 * `GET /api/learning/lessons`, which reads the very store the correction
 * learning writes to (`src/learning/harness/experienceStore.ts`), so what is
 * listed here is exactly what the agent would inject into a task.
 *
 * Reference: .h2-ref/BUILD_SPEC.md section 5 (the panel), section 8 (the REST
 * contract). Arabic labels come from the shared catalog in `@/i18n/t`; nothing
 * here invents its own copy, so `setLocale('ar')` is the only switch needed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, GraduationCap, Loader2, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { getLocale, t, type Locale } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { deleteLesson, listLessons, type Lesson } from '@/services/lessonsApi';
import { Row, Section } from './SettingsDialog';
import { Button } from '@/components/ui/Button';

/**
 * Source and confidence are machine vocabulary, not prose: the store only ever
 * emits these three values each. They still need a label per locale, so they use
 * the same `{ en, ar }` + `getLocale()` shape as `EffortPanel`/`agentLabels`
 * rather than the prose catalog (whose keys are English sentences).
 */
const SOURCE_LABELS: Record<Lesson['source'], Record<Locale, string>> = {
  correction: { en: 'User correction', ar: 'تصحيح المستخدم' },
  critic: { en: 'Critic review', ar: 'مراجعة الناقد' },
  selfplay: { en: 'Self-play', ar: 'اللعب الذاتي' },
};

const CONFIDENCE_LABELS: Record<Lesson['confidence'], Record<Locale, string>> = {
  low: { en: 'Low', ar: 'منخفضة' },
  medium: { en: 'Medium', ar: 'متوسطة' },
  high: { en: 'High', ar: 'عالية' },
};

/** Read a label in the active locale, falling back to English then the raw value. */
function localeLabel(map: Record<Locale, string>, fallback: string): string {
  return map[getLocale()] ?? map.en ?? fallback;
}

function sourceLabel(source: Lesson['source']): string {
  const map = SOURCE_LABELS[source];
  return map ? localeLabel(map, source) : source;
}

function confidenceLabel(confidence: Lesson['confidence']): string {
  const map = CONFIDENCE_LABELS[confidence];
  return map ? localeLabel(map, confidence) : confidence;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function LessonsPanel() {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [autoApply, setAutoApply] = useState(true);
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ msg, kind });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4200);
  }, []);

  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [payload, settingsRes] = await Promise.all([
          listLessons(),
          fetch(`${getApiBase()}/api/settings`, { headers: await getApiHeaders() }),
        ]);
        const settings = (await settingsRes.json().catch(() => ({}))) as { lessonsAutoApply?: boolean };
        if (!mounted) return;
        // Missing key means the spec default: ON.
        setLessons(payload.data ?? []);
        setAutoApply(settings.lessonsAutoApply !== false);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!mounted) return;
        setError(message);
        // eslint-disable-next-line no-console
        console.error('failed to load lessons', e);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const applyToggle = useCallback(async (next: boolean) => {
    setAutoApply(next);
    try {
      const res = await fetch(`${getApiBase()}/api/settings`, {
        method: 'POST',
        headers: { ...(await getApiHeaders()), 'content-type': 'application/json' },
        body: JSON.stringify({ lessonsAutoApply: next }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      notify(t(next ? 'Lessons will be applied automatically' : 'Lessons will not be applied automatically'));
    } catch (e) {
      // Roll the switch back: the server is the source of truth.
      setAutoApply(!next);
      notify(e instanceof Error ? e.message : String(e), 'err');
    }
  }, [notify]);

  const remove = useCallback(async (lesson: Lesson) => {
    setBusyId(lesson.id);
    try {
      await deleteLesson(lesson.id);
      setLessons((prev) => prev.filter((l) => l.id !== lesson.id));
      notify(t('Lesson deleted'));
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusyId(null);
    }
  }, [notify]);

  return (
    <div className="space-y-2">
      <Section title={t('Learned lessons')}>
        <Row label={t('Auto-apply lessons')} description={t('When on, a new task starts with the most relevant lessons already in its context.')}>
          <button
            type="button"
            role="switch"
            aria-checked={autoApply}
            aria-label={t('Auto-apply lessons')}
            onClick={() => void applyToggle(!autoApply)}
            className={clsx(
              'relative h-5 w-9 rounded-full transition-colors',
              autoApply ? 'bg-function-success' : 'bg-fill-hover',
            )}
          >
            <span
              className={clsx(
                'absolute top-0.5 size-4 rounded-full bg-white transition-transform',
                autoApply ? 'translate-x-4' : 'translate-x-0.5',
              )}
            />
          </button>
        </Row>
      </Section>

      <Section title={t('Lessons the agent distilled from your corrections and its own reviews. Delete one to stop it being applied.')}>
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-text-secondary">
            <Loader2 className="size-4 animate-spin" /> {t('Loading')}
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 py-4 text-function-error">
            <AlertCircle className="size-4 shrink-0" />
            <p className="text-sm">{t('Failed to load lessons')} {error}</p>
          </div>
        ) : lessons.length === 0 ? (
          <div className="flex items-start gap-2 py-4 text-text-tertiary">
            <GraduationCap className="size-4 shrink-0" />
            <div className="flex flex-col gap-1">
              <p className="text-sm">{t('No lessons yet.')}</p>
              <p className="text-xs">{t('Lessons are learned from corrections you make and from the agent\'s own review after a task.')}</p>
            </div>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {lessons.map((lesson) => (
              <li
                key={lesson.id}
                className="flex flex-col gap-2 rounded-card border border-border-main bg-bg-menu p-3"
                data-testid="lesson-row"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="text-sm text-text-primary">{lesson.lesson}</p>
                    <p className="text-xs text-text-secondary">{lesson.cue}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`${t('Delete')}: ${lesson.lesson}`}
                    disabled={busyId === lesson.id}
                    loading={busyId === lesson.id}
                    onClick={() => void remove(lesson)}
                  >
                    <Trash2 className="size-4" /> {t('Delete')}
                  </Button>
                </div>
                <p className="text-xs text-text-tertiary line-clamp-2">{lesson.evidence}</p>
                <dl className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-tertiary">
                  <div className="flex gap-1">
                    <dt>{t('Confidence')}:</dt>
                    <dd className={clsx(
                      'font-medium',
                      lesson.confidence === 'high' && 'text-function-success',
                      lesson.confidence === 'medium' && 'text-function-warning',
                    )}>
                      {confidenceLabel(lesson.confidence)}
                    </dd>
                  </div>
                  <div className="flex gap-1">
                    <dt>{t('Uses')}:</dt>
                    <dd>{lesson.uses}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt>{t('Source')}:</dt>
                    <dd>{sourceLabel(lesson.source)}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt>{t('Domain')}:</dt>
                    <dd>{lesson.domain}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt>{t('Created')}:</dt>
                    <dd>{formatDate(lesson.createdAt)}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {toast && (
        <div className="fixed bottom-5 start-5 z-[70]">
          <div className={clsx(
            'max-w-[420px] rounded-card px-3.5 py-2.5 text-sm shadow-layer',
            toast.kind === 'ok' ? 'bg-function-success text-white' : 'bg-function-error text-white',
          )}>
            {toast.msg}
          </div>
        </div>
      )}
    </div>
  );
}
