'use client';

import { Pencil, MessageSquare, Play } from 'lucide-react';
import { t } from '@/i18n/t';
import { Button, IconButton } from '@/components/ui/Button';
import { GrokBotBadge, isGrokBotAgent } from './GrokBotBadge';

export interface AgentCardAgent {
  id: string;
  name: string;
  emoji?: string;
  description?: string;
  mode?: string;
  workMode?: string;
  model?: string;
  /** Provenance ("grokbot" = imported from a Grok Bot bundle). */
  source?: string;
  /** Pin timestamp (epoch ms); set = pinned, shown in the Pinned section. */
  pinnedAt?: number;
  /** Position among pinned agents (smaller = higher). */
  sortOrder?: number;
}

interface AgentCardProps {
  agent: AgentCardAgent;
  onStart: (agent: AgentCardAgent) => void;
  onEdit: (agent: AgentCardAgent) => void;
}

export function AgentCard({ agent, onStart, onEdit }: AgentCardProps) {
  return (
    <div className="flex flex-col gap-3 rounded-card border border-border-main bg-bg-menu p-3 hover:border-border-dark transition-colors">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-fill-tsp text-lg">
          {agent.emoji || '🤖'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="min-w-0 truncate text-sm font-medium text-text-primary">{agent.name}</p>
            {isGrokBotAgent(agent.source) && <GrokBotBadge />}
          </div>
          {agent.description && (
            <p className="line-clamp-2 text-xs text-text-tertiary">{agent.description}</p>
          )}
        </div>
        <IconButton
          label={t('Edit')}
          onClick={() => onEdit(agent)}
          className="shrink-0 text-text-secondary hover:text-text-primary"
        >
          <Pencil className="size-4" />
        </IconButton>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs text-text-tertiary">
        <div className="rounded-control bg-fill-tsp px-2 py-1.5">
          <span className="block text-[10px] uppercase tracking-wider opacity-70">{t('Mode')}</span>
          <span className="text-text-secondary">{agent.mode || '—'}</span>
        </div>
        <div className="rounded-control bg-fill-tsp px-2 py-1.5">
          <span className="block text-[10px] uppercase tracking-wider opacity-70">{t('Work mode')}</span>
          <span className="text-text-secondary">{agent.workMode || 'loam'}</span>
        </div>
        {agent.model && (
          <div className="col-span-2 rounded-control bg-fill-tsp px-2 py-1.5">
            <span className="block text-[10px] uppercase tracking-wider opacity-70">{t('Model')}</span>
            <span className="text-text-secondary">{agent.model}</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="primary"
          size="sm"
          className="flex-1"
          onClick={() => onStart(agent)}
        >
          <MessageSquare className="size-4" />
          {t('Chat')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="flex-1"
          onClick={() => onStart(agent)}
        >
          <Play className="size-4" />
          {t('Task')}
        </Button>
      </div>
    </div>
  );
}
