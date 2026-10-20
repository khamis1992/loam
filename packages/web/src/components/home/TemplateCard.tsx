'use client';

interface TemplateCardProps {
  label: string;
  labelIcon: React.ReactNode;
  title: string;
  onClick?: () => void;
}

export function TemplateCard({ label, labelIcon, title, onClick }: TemplateCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative overflow-hidden rounded-card text-start transition-colors hover:bg-fill-hover"
    >
      <div className="mb-2 h-28 rounded bg-fill-hover" aria-hidden />
      <span className="absolute left-2 top-2 flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] font-medium text-white">
        {labelIcon}
        {label}
      </span>
      <p className="px-1 text-[13px] font-medium text-text-primary">{title}</p>
    </button>
  );
}
