'use client';

import { useEffect, useState } from 'react';
import { t } from '@/i18n/t';

/**
 * Content source for the home promo carousel: /promos.json in public/
 * (title, subtitle, prompt, image). The visual treatment stays the same;
 * only the slide content and the composer pre-fill prompt come from JSON.
 */
export interface PromoSlide {
  title: string;
  subtitle: string;
  prompt: string;
  image?: string;
}

const FALLBACK_SLIDES: PromoSlide[] = [
  { title: 'Create your Video', subtitle: 'Make ideas come alive', prompt: 'Create your Video' },
  { title: 'Build an App', subtitle: 'Turn ideas into products', prompt: 'Build an App' },
  { title: 'Design a Deck', subtitle: 'Pitch with confidence', prompt: 'Design a Deck' },
];

export function PromoBanner({ onSelect }: { onSelect?: (prompt: string) => void }) {
  const [slides, setSlides] = useState<PromoSlide[]>(FALLBACK_SLIDES);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    let mounted = true;
    fetch('/promos.json')
      .then(async (res) => (res.ok ? ((await res.json()) as PromoSlide[]) : null))
      .then((data) => {
        if (mounted && Array.isArray(data) && data.length > 0) setSlides(data);
      })
      .catch(() => {
        // keep the fallback slides when the content source is unavailable
      });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setIndex((i) => (i + 1) % slides.length), 6000);
    return () => clearInterval(id);
  }, [slides.length]);

  const slide = slides[index % slides.length];

  return (
    <button
      type="button"
      onClick={() => onSelect?.(slide.prompt || t(slide.title))}
      className="relative flex h-11 w-[200px] shrink-0 items-center gap-2 overflow-hidden rounded-[10px] bg-[#1a1a1a] px-3 text-start text-white"
    >
      <div className="flex size-[26px] shrink-0 items-center justify-center rounded bg-white/10">
        <svg viewBox="0 0 24 24" fill="none" className="size-4">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 12l3 3 5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-semibold leading-tight text-white">{t(slide.title)}</p>
        <p className="truncate text-[11px] text-[#a3a3a3]">{t(slide.subtitle)}</p>
      </div>
      <div className="flex shrink-0 flex-col items-center justify-center gap-[3px] ps-1">
        {slides.map((_, i) => (
          <span
            key={i}
            className="block h-[5px] w-[2px] rounded-full"
            style={{ background: i === index % slides.length ? '#fff' : 'rgba(255,255,255,0.35)' }}
            aria-hidden
          />
        ))}
      </div>
    </button>
  );
}