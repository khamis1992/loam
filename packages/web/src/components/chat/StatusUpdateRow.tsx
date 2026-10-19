import type { StatusUpdateEvent } from '@shared/socket';
import { t } from '@/i18n/t';

export function StatusUpdateRow({ e }: { e: StatusUpdateEvent }) {
  if (e.noRender) return null;
  const dot = e.agentStatus === 'running' ? '●' : '○';
  const text = e.agentStatus === 'waiting' ? t('Waiting for user...') : e.brief;
  return (
    <div className="text-sm text-text-tertiary">
      {dot} {text}
    </div>
  );
}
