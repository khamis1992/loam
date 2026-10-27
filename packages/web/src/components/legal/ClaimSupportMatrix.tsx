'use client';

import { t } from '@/i18n/t';

export interface ClaimSupportRow { id: string; text: string; support: string; reason: string; authorityAvids: string[]; evidenceFactIds: string[] }

export function ClaimSupportMatrix({ claims }: { claims: ClaimSupportRow[] }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead><tr><th className="p-2 text-start">{t('Claim')}</th><th className="p-2 text-start">{t('Support')}</th><th className="p-2 text-start">{t('Reason')}</th></tr></thead>
        <tbody>
          {claims.map((claim) => <tr key={claim.id} className="border-t"><td className="p-2">{claim.text}</td><td className="p-2">{t(claim.support)}</td><td className="p-2">{claim.reason}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}
