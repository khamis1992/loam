'use client';

import { t } from '@/i18n/t';
import type { AgentCardAgent } from './AgentCard';

const BUILT_IN_AGENTS: AgentCardAgent[] = [
  { id: 'explore', name: 'Explore', emoji: '◌', mode: 'ask', workMode: 'chat' },
  { id: 'reviewer', name: 'Reviewer', emoji: '🧐', mode: 'build', workMode: 'loam' },
  { id: 'coder', name: 'Coder', emoji: '⌘', mode: 'build', workMode: 'loam' },
];

export function BuiltInAgentCard({ agent }: { agent: AgentCardAgent }) {
  return (
    <div className="flex flex-col gap-3 rounded-card border border-dashed border-border-main bg-bg-menu/50 p-3 opacity-80">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-fill-tsp text-lg">
          {agent.emoji || '🤖'}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text-primary">{agent.name}</p>
          <p className="text-xs text-text-tertiary">{t('Built-in agent')}</p>
        </div>
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
      </div>
    </div>
  );
}

export function getBuiltInAgents(): AgentCardAgent[] {
  return BUILT_IN_AGENTS;
}
