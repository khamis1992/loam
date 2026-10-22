'use client';

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 36 36"
      fill="none"
      className={className}
      aria-hidden
    >
      <rect width="36" height="36" rx="9" fill="currentColor" />
      <path
        d="M10 14.5C10 12.6 11.6 11 13.5 11h9c1.9 0 3.5 1.6 3.5 3.5v7c0 1.9-1.6 3.5-3.5 3.5h-9C11.6 25 10 23.4 10 21.5v-7Z"
        stroke="#fff"
        strokeWidth="1.6"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M14 18.5l3-3.5 2.5 2.5 3.5-4 2.5 2.5"
        stroke="#fff"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
