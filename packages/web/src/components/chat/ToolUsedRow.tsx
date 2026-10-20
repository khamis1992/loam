import type { ToolUsedEvent } from '@shared/socket';
import { t } from '@/i18n/t';
import { Spinner } from '@/components/ui/Button';
import { humanizeToolName } from './toolLabels';

function StatusIcon({ s }: { s: ToolUsedEvent['status'] }) {
  if (s === 'running' || s === 'pending' || s === 'streaming' || s === 'argumentsFinished') return <Spinner className="size-3.5" />;
  const glyph = { success: '✓', error: '✕', failed: '✕', cancelled: '◼', stopped: '◼', rollback: '↶' }[s] ?? '•';
  return <span aria-label={s} className={s === 'success' ? 'text-func-success' : 'text-text-tertiary'}>{glyph}</span>;
}

export function ToolUsedRow({ e }: { e: ToolUsedEvent }) {
  const commands = e.detail?.suggestion?.commands;
  if (e.tool === 'suggestion' && commands && commands.length > 0) {
    return (
      <div className="flex flex-col">
        {commands.map((c, i) => (
          <button key={i} className="flex h-9 items-center gap-2 border-b border-border-main px-2 text-sm text-text-secondary hover:bg-fill-tsp">
            <span className="text-text-tertiary">💬</span> {c.content}
            <span className="ms-auto">→</span>
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="flex h-row-sm w-full items-center gap-2 rounded-control bg-fill-tsp px-2 text-start text-sm text-text-secondary hover:bg-fill-hover"
    >
      <span className="truncate">{t(humanizeToolName(e.tool))} {e.brief && <code className="text-xs">{e.brief}</code>}</span>
      <span className="ms-auto"><StatusIcon s={e.status} /></span>
    </div>
  );
}
