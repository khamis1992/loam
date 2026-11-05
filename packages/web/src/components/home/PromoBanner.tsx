'use client';

import { useEffect, useState } from 'react';
import { t } from '@/i18n/t';

export type PromoTarget = 'video' | 'game-development';

const SLIDES: Array<{
  target: PromoTarget;
  title: string;
  subtitle: string;
  image: string;
}> = [
  { target: 'video', title: 'Create your Video', subtitle: 'Make ideas come alive', image: '/promo.png' },
  { target: 'game-development', title: 'Game development', subtitle: 'Turn your idea into a game', image: '/game-promo.png' },
];

export function PromoBanner({ onSelect }: { onSelect?: (target: PromoTarget) => void }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setIndex((value) => (value + 1) % SLIDES.length), 6000);
    return () => clearInterval(id);
  }, []);

  const slide = SLIDES[index];

  return (
    <button
      type="button"
      onClick={() => onSelect?.(slide.target)}
      aria-label={t(slide.title)}
      className="relative flex h-14 w-64 shrink-0 items-center gap-2 overflow-hidden rounded-[10px] bg-[#1a1a1a] px-3 text-start text-white"
    >
      <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded bg-white/10">
        <img src={slide.image} alt="" className="size-full object-cover" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-semibold leading-tight text-white">{t(slide.title)}</p>
        <p className="truncate text-[11px] text-[#a3a3a3]">{t(slide.subtitle)}</p>
      </div>
      <div className="flex shrink-0 flex-col items-center justify-center gap-[3px] ps-1" aria-hidden>
        {SLIDES.map((item, itemIndex) => (
          <span
            key={item.target}
            className={itemIndex === index ? 'block h-[5px] w-[2px] rounded-full bg-white' : 'block h-[5px] w-[2px] rounded-full bg-white/35'}
          />
        ))}
      </div>
    </button>
  );
}