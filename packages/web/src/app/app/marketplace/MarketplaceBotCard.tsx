'use client';

import { AddAction, BotAvatar, CatalogEntry, categoryColor, composedInstructions, sourceLabel, toolLabel } from './marketplace-shared';

export function MarketplaceBotCard({
  entry,
  installedAgentId,
  pending,
  onOpenDetail,
  onAdd,
  onOpenAgent,
}: {
  entry: CatalogEntry;
  installedAgentId?: string;
  pending: boolean;
  onOpenDetail: () => void;
  onAdd: () => void;
  onOpenAgent: () => void;
}) {
  const color = categoryColor(entry.category);
  const tools = entry.tools.slice(0, 4);

  return (
    <div className="relative flex flex-col gap-3 rounded-[20px] border border-border-main bg-bg-menu p-5 shadow-card transition-all duration-[180ms] hover:-translate-y-0.5 hover:shadow-menu">
      <div className="flex items-start gap-2.5">
        <BotAvatar entry={entry} size={28} />
        <button
          type="button"
          onClick={onOpenDetail}
          className="min-w-0 flex-1 truncate text-start text-[19px] font-medium leading-tight text-text-primary after:absolute after:inset-0 after:z-[1] after:content-['']"
        >
          {entry.name}
        </button>
        <div className="relative z-[2]">
          <AddAction
            entry={entry}
            installedAgentId={installedAgentId}
            pending={pending}
            onAdd={onAdd}
            onOpenAgent={onOpenAgent}
          />
        </div>
      </div>

      <p className="line-clamp-4 min-h-[98px] rounded-[10px] border border-border-main bg-fill-tsp px-3 py-2.5 font-mono text-[12.5px] leading-[19px] text-text-tertiary">
        {entry.description || composedInstructions(entry)}
      </p>

      <div className="flex flex-wrap gap-1.5">
        {tools.map((tool) => (
          <span key={tool} className="rounded-[7px] border border-dark bg-bg-menu px-2 py-[3px] text-[12px] font-medium text-text-secondary">
            {toolLabel(tool)}
          </span>
        ))}
        {entry.tools.length > tools.length && (
          <span className="px-1 py-[3px] text-[12px] text-text-tertiary">+{entry.tools.length - tools.length}</span>
        )}
      </div>

      <div className="mt-auto flex items-end justify-between gap-2">
        <span
          className="rounded-[8px] border px-[9px] py-[3px] text-[11.5px] font-semibold"
          style={{ background: color.bg, color: color.fg, borderColor: color.border }}
        >
          {entry.category}
        </span>
        <span className="truncate font-mono text-[12.5px] text-text-tertiary">{sourceLabel(entry)}</span>
      </div>
    </div>
  );
}
