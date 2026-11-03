'use client';

/**
 * W-U3 — the unified memory page: one surface with four tabs instead of four
 * scattered settings panes. The panes are mounted as-is from
 * `components/settings` (they are self-contained, prop-less components that
 * talk to the same stores the agent reads), so this page shows exactly what
 * the model can see — it never forks the data.
 */
import { useState } from 'react';
import { t } from '@/i18n/t';
import { MemoryPane } from '@/components/settings/MemoryPane';
import { KnowledgeGardenPane } from '@/components/settings/KnowledgeGardenPane';
import { LessonsPanel } from '@/components/settings/LessonsPanel';
import { WikiSection } from '@/components/settings/WikiSection';
import { bi } from '@/components/marketplace/labels';

export type MemoryTab = 'memories' | 'garden' | 'lessons' | 'wiki';

function memoryTabs(): Array<{ id: MemoryTab; label: string }> {
  return [
    { id: 'memories', label: bi('Memories', 'الذكريات') },
    { id: 'garden', label: t('Knowledge Garden') },
    { id: 'lessons', label: bi('Lessons', 'الدروس') },
    { id: 'wiki', label: bi('Wiki', 'الويكي') },
  ];
}

export function MemoryHub() {
  const [tab, setTab] = useState<MemoryTab>('memories');

  return (
    <div className="mx-auto w-full max-w-[860px] px-6 py-8">
      <header className="mb-5">
        <h1 className="text-[32px] font-medium leading-tight tracking-[-0.01em] text-text-primary">{t('Memory')}</h1>
        <p className="mt-1.5 text-[14px] text-text-tertiary">
          {t('Everything the agent remembers, learned, and writes down — in one place.')}
        </p>
      </header>

      <div role="tablist" aria-label={t('Memory')} className="mb-4 flex items-center gap-1 border-b border-border-main">
        {memoryTabs().map((item) => (
          <button
            key={item.id}
            role="tab"
            type="button"
            aria-selected={tab === item.id}
            data-testid={`memory-tab-${item.id}`}
            onClick={() => setTab(item.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-[13.5px] font-medium transition-colors ${
              tab === item.id
                ? 'border-text-primary text-text-primary'
                : 'border-transparent text-text-tertiary hover:text-text-secondary'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* Panes keep their Settings layout (Section/Row) so both surfaces stay identical. */}
      <div role="tabpanel" data-testid={`memory-panel-${tab}`}>
        {tab === 'memories' && <MemoryPane />}
        {tab === 'garden' && <KnowledgeGardenPane />}
        {tab === 'lessons' && <LessonsPanel />}
        {tab === 'wiki' && <WikiSection />}
      </div>
    </div>
  );
}
