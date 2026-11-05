'use client';

import Image from 'next/image';

interface TemplateCardProps {
  title: string;
  imageSrc: string;
  imageAlt: string;
  onClick?: () => void;
}

export function TemplateCard({ title, imageSrc, imageAlt, onClick }: TemplateCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative overflow-hidden rounded-card text-start transition-colors hover:bg-fill-hover"
    >
      <div className="relative mb-2 h-[138px] w-full overflow-hidden rounded">
        <Image
          src={imageSrc}
          alt={imageAlt}
          fill
          sizes="(max-width: 768px) 33vw, 250px"
          className="object-cover"
          unoptimized
        />
      </div>
      <p className="px-1 text-[13px] font-medium text-text-primary">{title}</p>
    </button>
  );
}
