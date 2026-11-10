'use client';

import { useEffect, useState } from 'react';
import { AlarmClock, ArrowDown, Bot, CheckCircle2, CreditCard, Search, Sparkles } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';

const DEMOS = ['ai', 'payments', 'jobs', 'seo'] as const;
type Demo = typeof DEMOS[number];

function Preview({ demo }: { demo: Demo }) {
  if (demo === 'payments') {
    return (
      <div className="w-[210px] rounded-[10px] border border-border-main bg-bg-menu p-4 shadow-card">
        <div className="flex items-center justify-between text-[13px] font-medium text-text-primary"><span>{t('Checkout')}</span><span>Stripe</span></div>
        <p className="mt-4 text-xl font-semibold text-text-primary">$120.00</p>
        <div className="mt-3 flex justify-between rounded-[6px] border border-border-main p-2 text-[10px] text-text-tertiary"><span>•••• 4242</span><span>12/28</span></div>
        <span className="mt-3 block rounded-[5px] bg-text-primary py-1.5 text-center text-[10px] font-medium text-text-onblack">{t('Pay $120.00')}</span>
      </div>
    );
  }
  if (demo === 'jobs') {
    return (
      <div className="w-[210px] rounded-[10px] border border-border-main bg-bg-menu p-4 shadow-card">
        <div className="flex items-center gap-2"><AlarmClock className="size-4 text-text-secondary" /><div><p className="text-xs font-medium text-text-primary">{t('Morning briefing')}</p><p className="text-[9px] text-text-tertiary">{t('Every day at 8:00 AM')}</p></div></div>
        <div className="mt-4 space-y-2.5">
          {[t('Pulled market data'), t('Wrote the briefing'), t('Posted to homepage')].map((item, index) => (
            <div key={item} className="flex items-center gap-2 text-[10px] text-text-secondary"><CheckCircle2 className="size-3 text-func-success" /><span className="flex-1">{item}</span><span className="text-text-tertiary">8:0{index}</span></div>
          ))}
        </div>
      </div>
    );
  }
  if (demo === 'seo') {
    return (
      <div className="w-[220px] rounded-[10px] border border-border-main bg-bg-menu p-4 shadow-card">
        <p className="text-[10px] text-text-tertiary">yourname.com</p>
        <p className="mt-1 text-xs text-icon-blue">yourname.com</p>
        <div className="mt-3 flex items-start gap-2"><span className="rounded bg-func-success/10 px-1.5 py-0.5 text-[10px] font-medium text-func-success">#1</span><div><p className="text-xs font-medium text-text-primary">{t('Handmade Ceramics Studio')}</p><p className="mt-1 text-[9px] leading-4 text-text-tertiary">{t('Small-batch mugs and bowls, made by hand. Free shipping over $50.')}</p></div></div>
      </div>
    );
  }
  return (
    <div className="w-[210px] rounded-[10px] border border-border-main bg-bg-menu p-4 shadow-card">
      <div className="flex items-center gap-2"><span className="flex size-7 items-center justify-center rounded-full bg-fill-hover"><Bot className="size-4 text-text-secondary" /></span><div><p className="text-xs font-medium text-text-primary">{t('Site assistant')}</p><p className="text-[9px] text-text-tertiary">{t('Answers from your pages')}</p></div></div>
      <p className="ms-auto mt-4 w-fit rounded-lg bg-fill-tsp px-2.5 py-1.5 text-[10px] text-text-secondary">{t('Do you ship to Canada?')}</p>
      <p className="mt-2 rounded-lg bg-fill-tsp px-2.5 py-1.5 text-[10px] leading-4 text-text-secondary">{t('Yes. Orders over $50 ship free to Canada.')}</p>
      <p className="mt-1 text-[9px] text-icon-blue">{t('Shipping policy')}</p>
    </div>
  );
}

export function WebsiteHero({ onExplore }: { onExplore: () => void }) {
  const [demo, setDemo] = useState<Demo>('ai');
  useEffect(() => {
    const timer = window.setInterval(() => setDemo((current) => DEMOS[(DEMOS.indexOf(current) + 1) % DEMOS.length]!), 6000);
    return () => window.clearInterval(timer);
  }, []);
  const chips: Array<{ id: Demo; label: string; icon: typeof Sparkles }> = [
    { id: 'ai', label: 'AI integration', icon: Sparkles },
    { id: 'payments', label: 'Payments', icon: CreditCard },
    { id: 'jobs', label: 'Scheduled jobs', icon: AlarmClock },
    { id: 'seo', label: 'SEO', icon: Search },
  ];
  return (
    <section className="grid items-center gap-8 py-3 md:grid-cols-[1fr_360px] md:py-2" aria-labelledby="websites-hero-title">
      <div>
        <h2 id="websites-hero-title" className="max-w-[520px] font-serif text-[42px] leading-[1.04] tracking-[-0.025em] text-text-primary sm:text-[48px]">
          {t('You built a website.')}<br />{t('Now make it do more.')}
        </h2>
        <p className="mt-4 flex flex-wrap items-center gap-1.5 text-[13px] text-text-secondary">
          {t('Build on it, keep it fresh, grow it.')}
          <button type="button" onClick={onExplore} className="flex items-center gap-1 font-medium text-text-primary hover:underline">{t('Explore more')}<ArrowDown className="size-3.5" /></button>
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          {chips.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" aria-pressed={demo === id} onClick={() => setDemo(id)} className={clsx('flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px]', demo === id ? 'border-border-dark bg-bg-menu text-text-primary shadow-sm' : 'border-border-main text-text-secondary hover:bg-fill-tsp')}>
              <Icon className="size-3.5" aria-hidden />{t(label)}
            </button>
          ))}
        </div>
      </div>
      <button type="button" aria-label={t('Try it')} onClick={() => setDemo(DEMOS[(DEMOS.indexOf(demo) + 1) % DEMOS.length]!)} className="hidden min-h-[190px] items-center justify-center rounded-[14px] bg-fill-tsp p-5 md:flex">
        <Preview demo={demo} />
      </button>
    </section>
  );
}
