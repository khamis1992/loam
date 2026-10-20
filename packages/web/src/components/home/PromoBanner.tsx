'use client';

import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { t } from '@/i18n/t';

const SLIDES = [
  { titleKey: 'Create your Video', subtitleKey: 'Make ideas come alive', ctaKey: 'Try now' },
  { titleKey: 'Build an App', subtitleKey: 'Turn ideas into products', ctaKey: 'Try now' },
  { titleKey: 'Design a Deck', subtitleKey: 'Pitch with confidence', ctaKey: 'Try now' },
];

export function PromoBanner({ onSelect }: { onSelect?: (prompt: string) => void }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setIndex((i) => (i + 1) % SLIDES.length), 6000);
    return () => clearInterval(id);
  }, []);

  const slide = SLIDES[index];

  return (
    <div className="relative flex h-11 w-[200px] shrink-0 items-center gap-2 overflow-hidden rounded-control bg-[#1a1a1a] px-3 text-start text-white"
    >
      <div className="flex size-7 shrink-0 items-center justify-center rounded bg-white/10">
        <span className="text-sm">✦</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{t(slide.titleKey)}</p>
        <p className="truncate text-[11px] text-[#a3a3a3]">{t(slide.subtitleKey)}</p>
      </div>
      <div className="absolute bottom-1 end-2 flex items-center gap-1">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setIndex((i) => (i - 1 + SLIDES.length) % SLIDES.length); }}
          className="rounded p-0.5 text-white/50 hover:bg-white/10 hover:text-white"
          aria-label={t('Previous (←)')}
        >
          <ChevronLeft className="size-3" />
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setIndex((i) => (i + 1) % SLIDES.length); }}
          className="rounded p-0.5 text-white/50 hover:bg-white/10 hover:text-white"
          aria-label={t('Next (→)')}
        >
          <ChevronRight className="size-3" />
        </button>
      </div>
      <button
        type="button"
        onClick={() => onSelect?.(t(slide.titleKey))}
        className="absolute inset-0"
        aria-label={t(slide.ctaKey)}
      />
    </div>
  );
}
