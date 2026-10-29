'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, KeyRound, Loader2, Play, RefreshCw, Smartphone, Square, XCircle } from 'lucide-react';
import {
  RemoteApiError,
  clearToken,
  getRemoteTaskDetail,
  listRemoteTasks,
  loadToken,
  resumeRemoteTask,
  saveToken,
  stopRemoteTask,
  type RemoteTaskDetail,
  type RemoteTaskStatus,
  type RemoteTaskSummary,
} from './remoteApi';

const POLL_MS = 5000;

const STATUS_LABEL: Record<RemoteTaskStatus, string> = {
  queued: 'في الانتظار',
  running: 'يعمل الآن',
  done: 'مكتملة',
  error: 'خطأ',
  interrupted: 'متوقفة بمقاطعة',
  cancelled: 'ملغاة',
};

const STATUS_CLASS: Record<RemoteTaskStatus, string> = {
  queued: 'bg-amber-500/15 text-amber-300',
  running: 'bg-emerald-500/15 text-emerald-300',
  done: 'bg-sky-500/15 text-sky-300',
  error: 'bg-red-500/15 text-red-300',
  interrupted: 'bg-amber-500/15 text-amber-300',
  cancelled: 'bg-zinc-500/15 text-zinc-300',
};

/** Loam dark palette (matches the keyed phone page colors) — explicit values so
 *  the page stays dark regardless of the desktop theme class on <html>. */
const shell = 'min-h-dvh bg-[#0d1210] text-[#e8efe9]';

function formatRelative(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  try {
    const rtf = new Intl.RelativeTimeFormat('ar', { numeric: 'auto' });
    if (abs < 60) return rtf.format(seconds, 'second');
    if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
    return rtf.format(Math.round(seconds / 86400), 'day');
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

function StatusBadge({ status }: { status: RemoteTaskStatus }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs ${STATUS_CLASS[status] ?? 'bg-zinc-500/15 text-zinc-300'}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

/**
 * شاشة "Loam Remote" للهاتف: قائمة المهام الحية، متابعة المخرجات، إيقاف
 * واستئناف — عبر الشبكة المحلية أو Tailscale بدون أي خدمة سحابية. الصفحة
 * عامة أما نداءات /api فتحمل مفتاح التثبيت الذي يُدخل مرة واحدة.
 */
export function RemoteView() {
  const [token, setToken] = useState('');
  const [booted, setBooted] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);

  const [tasks, setTasks] = useState<RemoteTaskSummary[]>([]);
  const [listError, setListError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RemoteTaskDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [actionBusy, setActionBusy] = useState<'stop' | 'resume' | null>(null);
  const [actionNote, setActionNote] = useState('');
  const [confirmRetry, setConfirmRetry] = useState(false);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  // Boot once: reuse the stored token, or pick ?t=<token> from the URL (easy
  // phone onboarding — open the link once and the token is saved).
  useEffect(() => {
    const fromQuery = new URLSearchParams(window.location.search).get('t');
    if (fromQuery) saveToken(fromQuery.trim());
    setToken(fromQuery ? fromQuery.trim() : loadToken());
    setBooted(true);
  }, []);

  const handleAuthFailure = useCallback((message: string) => {
    clearToken();
    setToken('');
    setTokenInput('');
    setAuthError(message);
    setSelectedId(null);
    setDetail(null);
    setTasks([]);
  }, []);

  const runAction = useCallback(async (kind: 'stop' | 'resume', id: string, retryInterruptedStep: boolean) => {
    setActionBusy(kind);
    setActionNote('');
    try {
      if (kind === 'stop') {
        const result = await stopRemoteTask(id, token);
        setActionNote(result.note ?? 'أُرسل طلب الإيقاف.');
      } else {
        await resumeRemoteTask(id, token, retryInterruptedStep);
        setActionNote('بدأ الاستئناف.');
        setConfirmRetry(false);
      }
    } catch (error) {
      if (error instanceof RemoteApiError && error.status === 401) {
        handleAuthFailure('انتهت صلاحية المفتاح — أدخل المفتاح مرة أخرى.');
        return;
      }
      if (kind === 'resume' && error instanceof RemoteApiError) {
        const payload = error.payload as { requiresConfirmation?: boolean } | null;
        if (payload?.requiresConfirmation) {
          setConfirmRetry(true);
          setActionBusy(null);
          return;
        }
      }
      setActionNote(error instanceof Error ? `تعذر التنفيذ: ${error.message}` : 'تعذر التنفيذ.');
    } finally {
      setActionBusy(null);
    }
  }, [handleAuthFailure, token]);

  // Single poll loop: the task list while browsing, the open task's detail
  // while inspecting. Polling (not SSE) because EventSource cannot send the
  // install-token header.
  useEffect(() => {
    if (!booted || !token) return;
    let cancelled = false;

    const tick = async () => {
      setSyncing(true);
      try {
        const id = selectedRef.current;
        if (id) {
          const data = await getRemoteTaskDetail(id, token);
          if (cancelled) return;
          setDetail(data);
          setDetailError('');
        } else {
          const list = await listRemoteTasks(token);
          if (cancelled) return;
          setTasks(list);
          setListError('');
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof RemoteApiError && error.status === 401) {
          handleAuthFailure('انتهت صلاحية المفتاح — أدخل المفتاح مرة أخرى.');
          return;
        }
        if (selectedRef.current) setDetailError(error instanceof Error ? error.message : 'تعذر تحديث المهمة.');
        else setListError(error instanceof Error ? error.message : 'تعذر تحديث القائمة.');
      } finally {
        if (!cancelled) setSyncing(false);
      }
    };

    void tick();
    const timer = window.setInterval(() => { void tick(); }, POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [booted, token, selectedId, handleAuthFailure]);

  const submitToken = async () => {
    const candidate = tokenInput.trim();
    if (!candidate) return;
    setAuthBusy(true);
    setAuthError('');
    try {
      // Validating against a token-gated endpoint: /api/health and
      // /api/identity are public, so only a real /api/tasks call proves the
      // token is the install token.
      const list = await listRemoteTasks(candidate);
      saveToken(candidate);
      setToken(candidate);
      setTokenInput('');
      setTasks(list);
    } catch (error) {
      if (error instanceof RemoteApiError && error.status === 401) {
        setAuthError('المفتاح غير صحيح. تأكد من نسخ مفتاح التثبيت كاملًا.');
      } else {
        setAuthError(error instanceof Error ? `تعذر الاتصال بجهاز Loam: ${error.message}` : 'تعذر الاتصال بجهاز Loam.');
      }
    } finally {
      setAuthBusy(false);
    }
  };

  const openTask = (id: string) => {
    setSelectedId(id);
    setDetail(null);
    setDetailError('');
    setActionNote('');
    setConfirmRetry(false);
  };

  const closeTask = () => {
    setSelectedId(null);
    setDetail(null);
    setDetailError('');
    setActionNote('');
    setConfirmRetry(false);
  };

  if (!booted) {
    return (
      <main dir="rtl" className={`${shell} grid place-items-center`}>
        <Loader2 className="size-6 animate-spin text-[#9fb8a8]" aria-hidden />
      </main>
    );
  }

  // ---- token entry (first run / after expiry) ----
  if (!token) {
    return (
      <main dir="rtl" className={`${shell} mx-auto flex min-h-dvh w-full max-w-md flex-col gap-4 px-5 py-8`}>
        <div className="flex items-center gap-2">
          <Smartphone className="size-5 text-[#9fb8a8]" aria-hidden />
          <span className="text-lg font-semibold">Loam Remote</span>
        </div>
        <p className="text-sm leading-6 text-[#9fb8a8]">
          تحكم بمهام Loam من هاتفك عبر الشبكة المحلية أو Tailscale — بدون أي خدمة سحابية.
        </p>
        <label htmlFor="remote-token-input" className="flex items-center gap-1.5 text-sm font-medium">
          <KeyRound className="size-4 text-[#9fb8a8]" aria-hidden /> مفتاح التثبيت
        </label>
        <input
          id="remote-token-input"
          data-testid="remote-token-input"
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          value={tokenInput}
          onChange={(event) => setTokenInput(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void submitToken(); }}
          placeholder="الصق مفتاح التثبيت هنا"
          className="w-full rounded-xl border border-[#263229] bg-[#0b100d] px-3 py-3 text-sm text-[#e8efe9] placeholder:text-[#5c6f63] focus:border-[#4f7d5c] focus:outline-none"
        />
        <button
          type="button"
          data-testid="remote-token-submit"
          onClick={() => void submitToken()}
          disabled={authBusy || !tokenInput.trim()}
          className="flex items-center justify-center gap-2 rounded-xl bg-[#4f7d5c] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          {authBusy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          دخول
        </button>
        {authError ? (
          <p data-testid="remote-auth-error" className="flex items-start gap-1.5 text-sm text-red-300" role="alert">
            <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden /> {authError}
          </p>
        ) : null}
        <p className="mt-auto text-xs leading-5 text-[#5c6f63]">
          تجد المفتاح في تطبيق Loam على جهازك (إعدادات الوصول المحلي). يُحفظ على هذا الهاتف فقط ولا يغادر شبكتك.
        </p>
      </main>
    );
  }

  // ---- task detail ----
  if (selectedId) {
    const task = detail?.task;
    const messages = task?.messages ?? [];
    const latest = [...messages].reverse().slice(0, 12);
    const canStop = task?.status === 'running' || task?.status === 'queued';
    const canResume = !!detail?.recovery && (task?.status === 'interrupted' || task?.status === 'cancelled' || task?.status === 'error');
    return (
      <main dir="rtl" className={`${shell} mx-auto flex w-full max-w-md flex-col gap-4 px-4 py-5`}>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={closeTask}
            aria-label="رجوع إلى القائمة"
            className="flex size-9 items-center justify-center rounded-xl border border-[#263229] bg-[#131a17] text-[#9fb8a8] active:scale-95"
          >
            <ArrowRight className="size-4" aria-hidden />
          </button>
          <h1 className="min-w-0 flex-1 truncate text-base font-semibold" title={task?.title ?? selectedId}>
            {task?.title ?? selectedId}
          </h1>
          {syncing ? <RefreshCw className="size-4 animate-spin text-[#5c6f63]" aria-hidden /> : null}
        </div>

        {task ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-[#9fb8a8]">
            <StatusBadge status={task.status} />
            <span>آخر تحديث: {formatRelative(task.updatedAt)}</span>
            <span className="ms-auto">{task.stepCount != null ? `${task.stepCount} خطوة` : ''}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 py-8 text-sm text-[#9fb8a8]">
            <Loader2 className="size-4 animate-spin" aria-hidden /> جارٍ تحميل المهمة…
          </div>
        )}
        {detailError ? (
          <p className="text-sm text-red-300" role="alert">{detailError}</p>
        ) : null}

        {task?.error ? (
          <p className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs leading-5 text-red-300" dir="auto">{task.error}</p>
        ) : null}

        <section aria-label="أحدث المخرجات" className="flex min-h-0 flex-1 flex-col gap-2">
          <h2 className="text-sm font-semibold text-[#9fb8a8]">أحدث المخرجات</h2>
          {latest.length ? (
            <ol className="flex flex-col gap-2">
              {latest.map((message, index) => (
                <li
                  key={`${message.at}-${index}`}
                  className={`rounded-xl border p-3 text-sm leading-6 ${
                    message.role === 'assistant'
                      ? 'border-[#263229] bg-[#131a17] text-[#e8efe9]'
                      : 'border-[#1d2621] bg-[#0b100d] text-[#9fb8a8]'
                  }`}
                >
                  <div className="mb-1 text-[10px] text-[#5c6f63]">
                    {message.role === 'assistant' ? 'المساعد' : message.role === 'user' ? 'أنت' : 'النظام'} · {formatRelative(message.at)}
                  </div>
                  <p className="whitespace-pre-wrap break-words" dir="auto">{message.content || '(فارغ)'}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="py-6 text-center text-sm text-[#5c6f63]">لا توجد رسائل بعد.</p>
          )}
        </section>

        {actionNote ? (
          <p data-testid="remote-action-note" className="rounded-xl bg-[#131a17] p-3 text-xs leading-5 text-[#9fb8a8]" dir="auto">{actionNote}</p>
        ) : null}
        {confirmRetry ? (
          <button
            type="button"
            data-testid="remote-resume-confirm"
            onClick={() => void runAction('resume', selectedId, true)}
            disabled={actionBusy !== null}
            className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm font-semibold text-amber-300 disabled:opacity-50"
          >
            قد تكون الخطوة المتوقفة نفذت فعلًا — تأكيد إعادة محاولة الخطوة
          </button>
        ) : null}

        <div className="flex gap-2">
          {canStop ? (
            <button
              type="button"
              data-testid="remote-stop"
              onClick={() => void runAction('stop', selectedId, false)}
              disabled={actionBusy !== null}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-red-600/90 px-4 py-3 text-sm font-semibold text-white active:scale-[0.99] disabled:opacity-50"
            >
              {actionBusy === 'stop' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Square className="size-4" aria-hidden />}
              إيقاف
            </button>
          ) : null}
          {canResume ? (
            <button
              type="button"
              data-testid="remote-resume"
              onClick={() => void runAction('resume', selectedId, false)}
              disabled={actionBusy !== null}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#4f7d5c] px-4 py-3 text-sm font-semibold text-white active:scale-[0.99] disabled:opacity-50"
            >
              {actionBusy === 'resume' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Play className="size-4" aria-hidden />}
              استئناف
            </button>
          ) : null}
          {!canStop && !canResume ? (
            <p className="flex-1 rounded-xl border border-[#263229] bg-[#0b100d] p-3 text-center text-xs text-[#5c6f63]">
              لا توجد إجراءات متاحة لهذه المهمة الآن.
            </p>
          ) : null}
        </div>
      </main>
    );
  }

  // ---- task list ----
  return (
    <main dir="rtl" className={`${shell} mx-auto flex w-full max-w-md flex-col gap-4 px-4 py-5`}>
      <div className="flex items-center gap-2">
        <Smartphone className="size-5 text-[#9fb8a8]" aria-hidden />
        <h1 className="text-base font-semibold">مهام Loam</h1>
        <span className="ms-auto flex items-center gap-1 text-xs text-[#5c6f63]">
          {syncing ? <RefreshCw className="size-3.5 animate-spin" aria-hidden /> : null} تحديث تلقائي
        </span>
      </div>

      {listError ? (
        <p className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300" role="alert">{listError}</p>
      ) : null}

      {tasks.length ? (
        <ul className="flex flex-col gap-2" data-testid="remote-task-list">
          {tasks.map((task) => (
            <li key={task.id}>
              <button
                type="button"
                data-testid={`remote-task-${task.id}`}
                onClick={() => openTask(task.id)}
                className="flex w-full flex-col gap-1.5 rounded-xl border border-[#263229] bg-[#131a17] p-3 text-start active:scale-[0.99]"
              >
                <span className="flex w-full items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium" title={task.title}>{task.title || 'مهمة بدون عنوان'}</span>
                  <StatusBadge status={task.status} />
                </span>
                <span className="flex items-center gap-2 text-[11px] text-[#5c6f63]">
                  <span>{formatRelative(task.updatedAt)}</span>
                  {task.messageCount != null ? <span>· {task.messageCount} رسالة</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : !listError ? (
        <div className="flex flex-col items-center gap-2 py-14 text-sm text-[#5c6f63]">
          <p>لا توجد مهام بعد.</p>
          <p>ابدأ مهمة من تطبيق Loam على جهازك وستظهر هنا تلقائيًا.</p>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => handleAuthFailure('تم تسجيل الخروج. أدخل المفتاح مرة أخرى.')}
        className="mt-auto self-start rounded-xl border border-[#263229] px-4 py-2 text-xs text-[#9fb8a8] active:scale-95"
      >
        تغيير المفتاح / تسجيل الخروج
      </button>
    </main>
  );
}
