'use client';

import { useState } from 'react';
import { t } from '@/i18n/t';
import { legalApi, type EgressPolicy, type Matter } from '@/services/legalApi';

const OPTIONS: Array<{ value: EgressPolicy; label: string; help: string }> = [
  { value: 'local_only', label: 'On this computer only', help: 'Client text is processed only by the approved local model. Nothing leaves the device.' },
  { value: 'cloud_redacted', label: 'Cloud, with names and IDs removed', help: 'Party names, QID, phone, IBAN, e-mail and CR numbers are replaced before sending. Not available for privileged matters.' },
  { value: 'cloud_full', label: 'Cloud, full text', help: 'The full client text may be sent to the configured cloud model.' },
];

/** The ONLY place a matter's egress policy can change (no agent tool can). */
export function MatterPrivacy({ matter, onChange }: { matter: Matter; onChange: (m: Matter) => void }) {
  const [pending, setPending] = useState<EgressPolicy | null>(null);
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (value: EgressPolicy) => {
    setError(null);
    try { onChange((await legalApi.updateMatter(matter.id, { egress: value }, true)).matter); setPending(null); setAck(false); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <fieldset dir="rtl" className="space-y-2 rounded-lg border p-3 text-sm">
      <legend className="px-1 font-semibold">{t('Where may this matter be processed?')}</legend>
      {OPTIONS.map((o) => {
        const disabled = o.value === 'cloud_redacted' && matter.confidentiality === 'privileged';
        return (
          <label key={o.value} className={`flex gap-2 ${disabled ? 'opacity-50' : ''}`}>
            <input type="radio" name={`egress-${matter.id}`} disabled={disabled} checked={(pending ?? matter.egress) === o.value}
              onChange={() => { if (o.value === 'local_only') void save(o.value); else { setPending(o.value); setAck(false); } }} />
            <span><span className="font-medium">{t(o.label)}</span><br /><span className="opacity-75">{t(o.help)}</span></span>
          </label>
        );
      })}
      {pending && pending !== 'local_only' && (
        <div role="alertdialog" aria-label={t('Confirm cloud processing')} className="space-y-2 rounded-md border border-amber-600/50 bg-amber-50 p-2 dark:bg-amber-950">
          <label className="flex gap-2"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            {t('I confirm the client agreed that this matter may be processed by a cloud model.')}</label>
          <div className="flex gap-2">
            <button type="button" disabled={!ack} onClick={() => void save(pending)} className="rounded-md border px-3 py-1">{t('Allow')}</button>
            <button type="button" onClick={() => { setPending(null); setAck(false); }} className="rounded-md border px-3 py-1">{t('Cancel')}</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
    </fieldset>
  );
}
