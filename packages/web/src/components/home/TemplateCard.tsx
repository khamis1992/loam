'use client';

import Image from 'next/image';

interface TemplateCardProps {
  label: string;
  labelIcon: React.ReactNode;
  title: string;
  imageSrc: string;
  imageAlt: string;
  onClick?: () => void;
}

export function TemplateCard({ label, labelIcon, title, imageSrc, imageAlt, onClick }: TemplateCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative overflow-hidden rounded-card text-start transition-colors hover:bg-fill-hover"
    >
      <div className="relative mb-2 h-28 w-full overflow-hidden rounded">
        <Image
          src={imageSrc}
          alt={imageAlt}
          fill
          sizes="(max-width: 768px) 33vw, 200px"
          className="object-cover"
          unoptimized
        />
      </div>
      <span className="absolute left-2 top-2 flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] font-medium text-white">
        {labelIcon}
        {label}
      </span>
      <p className="px-1 text-[13px] font-medium text-text-primary">{title}</p>
    </button>
  );
}
