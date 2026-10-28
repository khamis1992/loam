'use client';

import { t } from '@/i18n/t';
import type { EvidenceAnchor, FactAssertion } from '@/services/legalApi';

export function IssueMatrix({ facts, onSelect }: { facts: FactAssertion[]; onSelect: (anchor: EvidenceAnchor) => void }) {
  return (
    <section>
      <h3 className="mb-2 font-semibold">{t('Facts and evidence')}</h3>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead><tr><th className="p-2 text-start">{t('Fact')}</th><th className="p-2 text-start">{t('Status')}</th><th className="p-2 text-start">{t('Source')}</th></tr></thead>
          <tbody>
            {facts.map((fact) => (
              <tr key={fact.id} className="border-t">
                <td className="p-2">{fact.text}</td>
                <td className="p-2 text-xs">{t(fact.status)}</td>
                <td className="p-2">{fact.anchors[0] && <button type="button" className="text-teal-700 underline dark:text-teal-300" onClick={() => onSelect(fact.anchors[0]!)}>{t('Open source')}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
