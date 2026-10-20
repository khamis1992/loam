'use client';

import { useEffect, useState } from 'react';
import { t } from '@/i18n/t';

const SLIDES = [
  { titleKey: 'Create your Video', subtitleKey: 'Make ideas come alive' },
  { titleKey: 'Build an App', subtitleKey: 'Turn ideas into products' },
  { titleKey: 'Design a Deck', subtitleKey: 'Pitch with confidence' },
];

export function PromoBanner({ onSelect }: { onSelect?: (prompt: string) => void }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setIndex((i) => (i + 1) % SLIDES.length), 6000);
    return () => clearInterval(id);
  }, []);

  const slide = SLIDES[index];

  return (
    <button
      type="button"
      onClick={() => onSelect?.(t(slide.titleKey))}
      className="relative flex h-11 w-[200px] shrink-0 items-center gap-2 overflow-hidden rounded-[10px] bg-[#1a1a1a] px-3 text-start text-white"
    >
      <div className="flex size-[26px] shrink-0 items-center justify-center rounded bg-white/10">
        <svg viewBox="0 0 24 24" fill="none" className="size-4">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 12l3 3 5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-semibold leading-tight">{t(slide.titleKey)}</p>
        <p className="truncate text-[11px] text-[#a3a3a3]">{t(slide.subtitleKey)}</p>
      </div>
      <div className="flex shrink-0 flex-col items-center justify-center gap-[3px] ps-1">
        {SLIDES.map((_, i) => (
          <span
            key={i}
            className="block h-[5px] w-[2px] rounded-full"
            style={{ background: i === index ? '#fff' : 'rgba(255,255,255,0.35)' }}
            aria-hidden
          />
        ))}
      </div>
    </button>
  );
}
