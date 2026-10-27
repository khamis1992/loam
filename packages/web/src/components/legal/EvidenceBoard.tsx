'use client';

import { useState } from 'react';
import { t } from '@/i18n/t';
import type { EvidenceAnchor, EvidenceWorkspace } from '@/services/legalApi';
import { TimelineView } from './TimelineView';
import { IssueMatrix } from './IssueMatrix';
import { SourceInspector } from './SourceInspector';

export function EvidenceBoard({ workspace }: { workspace: EvidenceWorkspace }) {
  const [selected, setSelected] = useState<EvidenceAnchor | null>(null);
  const document = selected ? workspace.documents.find((item) => item.id === selected.documentId) : undefined;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <section className="space-y-3">
        <h3 className="font-semibold">{t('Evidence documents')}</h3>
        <ul className="space-y-2">
          {workspace.documents.map((document) => (
            <li key={document.id} className="rounded-md border p-3">
              <div className="font-medium">{document.fileName}</div>
              <div dir="ltr" className="text-xs opacity-60">{document.sha256.slice(0, 16)}</div>
              {document.warnings.length > 0 && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{document.warnings.join(' · ')}</p>}
            </li>
          ))}
        </ul>
        <IssueMatrix facts={workspace.facts} onSelect={setSelected} />
        <TimelineView events={workspace.timeline} />
      </section>
      <SourceInspector document={document} anchor={selected} />
    </div>
  );
}
