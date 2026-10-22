import { t } from '@/i18n/t';

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-2 text-center">
      <div className="text-3xl text-text-tertiary">🚧</div>
      <h3 className="text-title-base text-text-primary">{title}</h3>
      {description && <p className="max-w-xs text-sm text-text-secondary">{description}</p>}
    </div>
  );
}
