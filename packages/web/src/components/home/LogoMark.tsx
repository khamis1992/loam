'use client';

import Image from 'next/image';

export function LogoMark({ className }: { className?: string }) {
  return (
    <Image
      src="/loam-mark.png"
      alt="Loam"
      width={256}
      height={256}
      className={className}
      aria-hidden
      unoptimized
    />
  );
}
