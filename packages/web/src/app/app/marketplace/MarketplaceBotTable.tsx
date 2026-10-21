'use client';

import { t } from '@/i18n/t';
import {
  AddAction,
  BotActionProps,
  CatalogEntry,
  TABLE_COLUMNS,
  categoryColor,
  sourceLabel,
  toolLabel,
} from './marketplace-shared';

type RowProps = BotActionProps & { onOpenDetail: () => void };

function BotRow({ entry, installedAgentId, pending, onOpenDetail, onAdd, onOpenAgent }: RowProps) {
  const color = categoryColor(entry.category);
  const tools = entry.tools.slice(0, 3);
  const extra = entry.tools.length - tools.length;

  return (
    <div
      className="relative grid items-center gap-4 border-b border-border-main px-[18px] py-[13px] transition-colors last:border-b-0 hover:bg-fill-hover"
      style={{ gridTemplateColumns: TABLE_COLUMNS }}
    >
      <div className="flex min-w-0 flex-col gap-[3px]">
        <button
          type="button"
          onClick={onOpenDetail}
          className="truncate text-start text-[15.5px] font-medium tracking-[-0.01em] text-text-primary after:absolute after:inset-0 after:z-[1] after:content-['']"
        >
          {entry.name}
        </button>
        <span className="truncate text-[12.5px] text-text-tertiary">{entry.description}</span>
      </div>

      <div>
        <span
          className="inline-block rounded-[8px] border px-[9px] py-[3px] text-[11.5px] font-semibold"
          style={{ background: color.bg, color: color.fg, borderColor: color.border }}
        >
          {entry.category}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-text-tertiary">
        {tools.length === 0 ? (
          <span className="text-text-tertiary">—</span>
        ) : (
          tools.map((tool) => <span key={tool} className="whitespace-nowrap">{toolLabel(tool)}</span>)
        )}
        {extra > 0 && <span className="text-text-tertiary">+{extra}</span>}
      </div>

      <span className="truncate font-mono text-[12.5px] text-text-secondary">{sourceLabel(entry)}</span>

      <div className="relative z-[2] flex justify-end">
        <AddAction
          entry={entry}
          installedAgentId={installedAgentId}
          pending={pending}
          onAdd={onAdd}
          onOpenAgent={onOpenAgent}
          compact
        />
      </div>
    </div>
  );
}

export function MarketplaceBotTable({
  entries,
  installs,
  pending,
  onOpenDetail,
  onAdd,
  onOpenAgent,
}: {
  entries: CatalogEntry[];
  installs: Record<string, string>;
  pending: Record<string, boolean>;
  onOpenDetail: (entry: CatalogEntry) => void;
  onAdd: (entry: CatalogEntry) => void;
  onOpenAgent: (agentId: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-[20px] border border-border-main bg-bg-menu shadow-card">
      <div
        className="grid items-center gap-4 border-b border-border-main bg-fill-tsp px-[18px] py-3 text-[12px] font-semibold text-text-tertiary"
        style={{ gridTemplateColumns: TABLE_COLUMNS }}
      >
        <span>{t('Bot')}</span>
        <span>{t('Category')}</span>
        <span>{t('Integrations')}</span>
        <span>{t('Source')}</span>
        <span className="justify-self-end">{t('Add')}</span>
      </div>
      {entries.map((entry) => (
        <BotRow
          key={entry.id}
          entry={entry}
          installedAgentId={installs[entry.id]}
          pending={Boolean(pending[entry.id])}
          onOpenDetail={() => onOpenDetail(entry)}
          onAdd={() => onAdd(entry)}
          onOpenAgent={() => {
            const agentId = installs[entry.id];
            if (agentId) onOpenAgent(agentId);
          }}
        />
      ))}
    </div>
  );
}
