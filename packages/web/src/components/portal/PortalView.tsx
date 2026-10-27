'use client';

import { useEffect, useState } from 'react';
import { CalendarClock, FileText, Loader2, Scale, XCircle } from 'lucide-react';
import { usePathname, useSearchParams } from 'next/navigation';
import { getApiBase, getLoamBase } from '@/services/rpc';

/** Mirrors `ClientPortalView` in src/office/intelligence/legal/portal.ts — the
 * exact shape GET /api/office/portal/:token returns inside `{ portal: ... }`. */
export interface ClientPortalView {
  title: string;
  client: string;
  status: 'active' | 'on-hold' | 'closed';
  summary: string;
  updatedAt: string;
  deadlines: Array<{ id: string; title: string; dueAt: string; status: string; owner?: string }>;
  artifacts: string[];
}

const STATUS_LABEL: Record<ClientPortalView['status'], string> = {
  active: 'نشطة',
  'on-hold': 'متوقفة مؤقتًا',
  closed: 'مغلقة',
};

/**
 * Resolve the portal token from the URL: `/portal/<token>` (path form, what the
 * server links to) or `/portal?t=<token>` (query form), exactly like ShareReplay
 * does for `/share`.
 */
function resolveToken(searchParams: URLSearchParams, pathname: string): string {
  const fromQuery = searchParams.get('t');
  if (fromQuery) return fromQuery;
  if (pathname.startsWith('/portal/')) {
    const tail = pathname.slice('/portal/'.length).replace(/\/+$/, '');
    if (tail) return decodeURIComponent(tail);
  }
  return '';
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try { return date.toLocaleDateString('ar', { year: 'numeric', month: 'long', day: 'numeric' }); }
  catch { return date.toISOString().slice(0, 10); }
}

/**
 * بوابة العميل العامة: صفحة قراءة فقط تعرض حالة القضية للعميل عبر رابط
 * موقّع برمز. لا تحتوي على أي إجراءات كتابة؛ البيانات تأتي من
 * GET /api/office/portal/:token وهو مسار عام لا يتطلب تسجيل دخول.
 */
export function PortalView() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const token = resolveToken(searchParams, pathname);
  const [state, setState] = useState<'loading' | 'ready' | 'not-found' | 'invalid'>('loading');
  const [portal, setPortal] = useState<ClientPortalView | null>(null);

  useEffect(() => {
    if (!token.trim()) { setState('invalid'); return; }
    let cancelled = false;
    setState('loading');
    (async () => {
      // Same candidate bases as the share replay: the desktop protocol adapter,
      // the same-origin /api of a hosted deployment, then the direct Loam server.
      const bases = [...new Set([getApiBase(), getLoamBase()])];
      for (const base of bases) {
        try {
          const res = await fetch(`${base}/api/office/portal/${encodeURIComponent(token)}`);
          if (res.status === 404) { if (!cancelled) setState('not-found'); continue; }
          if (!res.ok) continue;
          const data = (await res.json()) as { portal?: ClientPortalView };
          if (!data.portal) continue;
          if (!cancelled) { setPortal(data.portal); setState('ready'); }
          return;
        } catch {
          // try the next base
        }
      }
      if (!cancelled) setState('not-found');
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <main className="mx-auto w-full max-w-[768px] px-6 py-10" dir="rtl">
      <div className="mb-6 flex items-center gap-2">
        <Scale className="size-5 text-text-secondary" aria-hidden />
        <span className="text-base font-semibold text-text-primary">بوابة العميل القانونية</span>
        <span className="ms-auto inline-flex items-center gap-1 rounded-full bg-fill-tsp px-2.5 py-1 text-xs text-text-secondary">
          عرض للقراءة فقط
        </span>
      </div>

      {state === 'loading' && (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-text-secondary">
          <Loader2 className="size-5 animate-spin" /> جارٍ التحميل…
        </div>
      )}

      {(state === 'not-found' || state === 'invalid') && (
        <div className="flex flex-col items-center gap-2 py-16 text-center text-sm text-text-secondary" role="alert">
          <XCircle className="size-6 text-func-error" aria-hidden />
          <p>هذا الرابط غير صالح أو منتهي الصلاحية أو ملغى.</p>
          <p className="text-xs text-text-tertiary">تواصل مع فريقك القانوني للحصول على رابط بوابة سليم.</p>
        </div>
      )}

      {state === 'ready' && portal && (
        <article className="flex flex-col gap-4">
          <header className="rounded-card border border-border-main bg-bg-menu p-4">
            <h1 className="text-xl font-semibold text-text-primary">{portal.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-text-secondary">
              <span>العميل: <span className="text-text-primary">{portal.client}</span></span>
              <span className="rounded-full bg-fill-tsp px-2.5 py-0.5 text-xs">{STATUS_LABEL[portal.status] ?? portal.status}</span>
              <span className="ms-auto text-xs text-text-tertiary">آخر تحديث: {formatDate(portal.updatedAt)}</span>
            </div>
          </header>

          <div className="grid grid-cols-2 gap-2 text-xs">
            <span className="rounded-control border border-border-light bg-bg-menu p-2" data-testid="portal-counter-deadlines">مواعيد قادمة: {portal.deadlines.length}</span>
            <span className="rounded-control border border-border-light bg-bg-menu p-2" data-testid="portal-counter-artifacts">مستندات ومرفقات: {portal.artifacts.length}</span>
          </div>

          {portal.summary ? (
            <section className="rounded-card border border-border-main bg-bg-menu p-4" aria-label="ملخص القضية">
              <h2 className="mb-2 text-sm font-semibold text-text-primary">ملخص القضية</h2>
              <p className="whitespace-pre-wrap text-sm text-text-secondary">{portal.summary}</p>
            </section>
          ) : null}

          <section className="rounded-card border border-border-main bg-bg-menu p-4" aria-label="المواعيد القادمة">
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-text-primary">
              <CalendarClock className="size-4" aria-hidden /> المواعيد القادمة
            </h2>
            {portal.deadlines.length ? (
              <ul className="flex flex-col gap-2">
                {portal.deadlines.map((deadline) => (
                  <li key={deadline.id} className="rounded-control border border-border-light bg-bg-main p-2 text-sm">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-medium text-text-primary">{deadline.title}</span>
                      <span className="text-xs text-func-warning">الاستحقاق: {formatDate(deadline.dueAt)}</span>
                      {deadline.owner ? <span className="ms-auto text-xs text-text-tertiary">المسؤول: {deadline.owner}</span> : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-text-secondary">لا توجد مواعيد قادمة مسجلة.</p>
            )}
          </section>

          <section className="rounded-card border border-border-main bg-bg-menu p-4" aria-label="المستندات والمرفقات">
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-text-primary">
              <FileText className="size-4" aria-hidden /> المستندات والمرفقات
            </h2>
            {portal.artifacts.length ? (
              <ul className="flex flex-col gap-1">
                {portal.artifacts.map((name) => (
                  <li key={name} className="rounded-control bg-bg-main px-2 py-1 text-sm" dir="auto">{name}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-text-secondary">لا توجد مستندات منشورة بعد.</p>
            )}
          </section>

          <p className="text-xs text-text-quaternary">هذه البوابة عرض للقراءة فقط ولا توفر أي إجراء لتعديل بيانات القضية.</p>
        </article>
      )}
    </main>
  );
}
