'use client';

import { PRODUCT } from '@/i18n/t';

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-label={PRODUCT}
    >
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <path
        d="M8 12c0-1.1.9-2 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2v-8Z"
        fill="#fff"
        fillOpacity="0.2"
      />
      <path
        d="M10 16.5l3.5-3.5 3 3 4-5 3 3.5"
        stroke="#fff"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
