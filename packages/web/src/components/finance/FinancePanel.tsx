'use client';

import { useState } from 'react';
import { Download, Landmark, ShieldAlert, TrendingUp } from 'lucide-react';
import { t } from '@/i18n/t';
import { Button } from '@/components/ui/Button';
import { financeApi, typstApi, type AuditFinding, type DcfResult, type LedgerEntry, type RatiosResult } from '@/services/financeApi';

/** Finance panel (blueprint §7.5): DCF, multiples, ratios, and the mechanical
 *  accounting audit — user-supplied numbers, computed locally, honest about
 *  what it is NOT (no market feeds, no live prices — those are BYOK). */

const pct = (value: number | null, digits = 1): string =>
  value === null ? '—' : `${(value * 100).toFixed(digits)}%`;
const num = (value: number, digits = 0): string =>
  value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });

function DcfForm() {
  const [flows, setFlows] = useState('1000, 1100, 1250');
  const [rate, setRate] = useState('0.10');
  const [growth, setGrowth] = useState('0.02');
  const [netCash, setNetCash] = useState('0');
  const [result, setResult] = useState<DcfResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true); setError(null);
    try {
      const cashFlows = flows.split(',').map((v) => Number(v.trim())).filter(Number.isFinite);
      setResult((await financeApi.dcf({
        cashFlows, discountRate: Number(rate), terminalGrowth: Number(growth), netCash: Number(netCash) || 0,
      })).result);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex flex-col gap-2 rounded-card border border-border-main bg-bg-menu p-3">
      <div className="flex items-center gap-2 text-sm font-medium"><TrendingUp className="size-4 text-icon-blue" /> {t('DCF valuation')}</div>
      <div className="flex flex-wrap gap-2">
        <input dir="ltr" value={flows} onChange={(e) => setFlows(e.target.value)} aria-label={t('Cash flows (comma-separated)')} placeholder="1000, 1100, 1250" className="min-w-40 flex-1 rounded-control border border-border-main bg-bg-main px-2 py-1.5 text-sm" />
        <input dir="ltr" value={rate} onChange={(e) => setRate(e.target.value)} aria-label={t('Discount rate')} className="w-24 rounded-control border border-border-main bg-bg-main px-2 py-1.5 text-sm" />
        <input dir="ltr" value={growth} onChange={(e) => setGrowth(e.target.value)} aria-label={t('Terminal growth')} className="w-24 rounded-control border border-border-main bg-bg-main px-2 py-1.5 text-sm" />
        <input dir="ltr" value={netCash} onChange={(e) => setNetCash(e.target.value)} aria-label={t('Net cash')} className="w-24 rounded-control border border-border-main bg-bg-main px-2 py-1.5 text-sm" />
        <Button size="sm" loading={busy} onClick={() => void run()}>{t('Compute')}</Button>
      </div>
      {error && <p role="alert" className="text-sm text-func-error">{error}</p>}
      {result && (
        <div data-testid="dcf-result" className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <span className="rounded-control bg-bg-main p-2">{t('Enterprise value')}: <b dir="ltr">{num(result.enterpriseValue)}</b></span>
          <span className="rounded-control bg-bg-main p-2">{t('Equity value')}: <b dir="ltr">{num(result.equityValue)}</b></span>
          <span className="rounded-control bg-bg-main p-2">{t('Terminal value')}: <b dir="ltr">{num(result.terminalValue)}</b></span>
          <span className="rounded-control bg-bg-main p-2">{t('PV of flows')}: <b dir="ltr">{num(result.discountedFlows.reduce((s, r) => s + r.presentValue, 0))}</b></span>
        </div>
      )}
    </div>
  );
}

function MultiplesForm() {
  const [rows, setRows] = useState('شركة أ, 12, 6\nشركة ب, 18, 8\nشركة ج, 24, 7');
  const [result, setResult] = useState<{ medianPe: number | null; medianEvEbitda: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true); setError(null);
    try {
      const entries = rows.split('\n').map((line) => {
        const [name, pe, evEbitda] = line.split(',').map((v) => v.trim());
        return { name: name ?? '', pe: Number(pe) || undefined, evEbitda: Number(evEbitda) || undefined };
      }).filter((e) => e.name);
      setResult((await financeApi.multiples(entries)).result);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex flex-col gap-2 rounded-card border border-border-main bg-bg-menu p-3">
      <div className="text-sm font-medium">{t('Comparable multiples')}</div>
      <textarea dir="ltr" rows={3} value={rows} onChange={(e) => setRows(e.target.value)} aria-label={t('Comps (name, P/E, EV/EBITDA per line)')} className="rounded-control border border-border-main bg-bg-main px-2 py-1.5 text-sm" />
      <Button size="sm" loading={busy} onClick={() => void run()} className="self-start">{t('Compute')}</Button>
      {error && <p role="alert" className="text-sm text-func-error">{error}</p>}
      {result && (
        <div data-testid="multiples-result" className="flex gap-2 text-xs">
          <span className="rounded-control bg-bg-main p-2">{t('Median P/E')}: <b dir="ltr">{result.medianPe ?? '—'}</b></span>
          <span className="rounded-control bg-bg-main p-2">{t('Median EV/EBITDA')}: <b dir="ltr">{result.medianEvEbitda ?? '—'}</b></span>
        </div>
      )}
    </div>
  );
}

function AuditForm() {
  const [rows, setRows] = useState('p1, payment, شركة النور, 5000, 2026-01-05\np2, payment, شركة النور, 5000, 2026-01-08');
  const [findings, setFindings] = useState<AuditFinding[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true); setError(null);
    try {
      const entries = rows.split('\n').map((line) => {
        const [id, kind, party, amount, date] = line.split(',').map((v) => v.trim());
        return { id, kind, party, amount: Number(amount), date } as LedgerEntry;
      }).filter((e) => e.id && e.party && Number.isFinite(e.amount));
      setFindings((await financeApi.audit(entries)).result.findings);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex flex-col gap-2 rounded-card border border-border-main bg-bg-menu p-3">
      <div className="flex items-center gap-2 text-sm font-medium"><ShieldAlert className="size-4 text-function-warning" /> {t('Accounting audit')}</div>
      <p className="text-xs text-text-tertiary">{t('One entry per line: id, invoice|payment|contract, party, amount, date[, contractId]')}</p>
      <textarea dir="ltr" rows={3} value={rows} onChange={(e) => setRows(e.target.value)} aria-label={t('Ledger entries')} className="rounded-control border border-border-main bg-bg-main px-2 py-1.5 font-mono text-xs" />
      <Button size="sm" loading={busy} onClick={() => void run()} className="self-start">{t('Run audit')}</Button>
      {error && <p role="alert" className="text-sm text-func-error">{error}</p>}
      {findings && (
        <ul data-testid="audit-findings" className="flex flex-col gap-1 text-xs">
          {findings.length === 0 && <li className="text-func-success">{t('No findings — the ledger passes the mechanical checks.')}</li>}
          {findings.map((finding, i) => (
            <li key={i} className={finding.severity === 'high' ? 'rounded-control border border-func-error p-2' : 'rounded-control border border-function-warning p-2'}>
              {finding.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatementsForm() {
  const [rows, setRows] = useState('2025, 1000, 100, 200, 100\n2026, 1200, 180, 300, 100');
  const [result, setResult] = useState<RatiosResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true); setError(null);
    try {
      const years = rows.split('\n').map((line) => {
        const [year, revenue, netIncome, currentAssets, currentLiabilities] = line.split(',').map((v) => Number(v.trim()));
        return { year, revenue, netIncome, currentAssets, currentLiabilities };
      }).filter((y) => Number.isFinite(y.revenue));
      setResult((await financeApi.statements(years)).result);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex flex-col gap-2 rounded-card border border-border-main bg-bg-menu p-3">
      <div className="text-sm font-medium">{t('Statement ratios')}</div>
      <p className="text-xs text-text-tertiary">{t('One year per line: year, revenue, net income, current assets, current liabilities')}</p>
      <textarea dir="ltr" rows={2} value={rows} onChange={(e) => setRows(e.target.value)} aria-label={t('Historical years')} className="rounded-control border border-border-main bg-bg-main px-2 py-1.5 font-mono text-xs" />
      <Button size="sm" loading={busy} onClick={() => void run()} className="self-start">{t('Compute')}</Button>
      {error && <p role="alert" className="text-sm text-func-error">{error}</p>}
      {result && (
        <table data-testid="ratios-table" className="text-xs">
          <thead><tr className="text-text-tertiary"><th className="p-1 text-start">{t('Year')}</th><th className="p-1">{t('Net margin')}</th><th className="p-1">{t('Current ratio')}</th><th className="p-1">{t('Revenue growth')}</th></tr></thead>
          <tbody>
            {result.rows.map((row) => (
              <tr key={row.year} className="border-t border-border-light">
                <td className="p-1" dir="ltr">{row.year}</td>
                <td className="p-1 text-center" dir="ltr">{pct(row.netMargin)}</td>
                <td className="p-1 text-center" dir="ltr">{row.currentRatio.toFixed(2)}</td>
                <td className="p-1 text-center" dir="ltr">{row.revenueGrowth === null ? '—' : pct(row.revenueGrowth)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function FinancePanel() {
  const [reportBusy, setReportBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const downloadSampleReport = async () => {
    setReportBusy(true); setNotice(null);
    try {
      // Sample DCF report through the Typst engine (§7.3 + §7.5 together).
      const { pdf } = await (async () => {
        const dcf = (await financeApi.dcf({ cashFlows: [1000, 1100, 1250], discountRate: 0.1, terminalGrowth: 0.02 })).result;
        const markup = [
          '#set text(lang: "ar")',
          '= تقرير تقييم نموذجي (DCF)',
          'هذا تقرير تجريبي مولّد محليًا عبر محرك Typst.',
          '#heading(level: 2)[الافتراضات]',
          '- معدل الخصم: 10%',
          '- النمو الأبدي: 2%',
          '- التدفقات: 1000، 1100، 1250',
          `#heading(level: 2)[النتيجة]`,
          `القيمة الحالية للمؤسسة: #text(fill: blue)[${dcf.enterpriseValue.toFixed(0)}]`,
        ].join('\n');
        return { pdf: await typstApi.compilePdf(markup) };
      })();
      const url = URL.createObjectURL(pdf);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'loam-dcf-report.pdf';
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice(t('PDF report downloaded.'));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally { setReportBusy(false); }
  };

  return (
    <section aria-label={t('Financial analysis')} className="flex flex-col gap-3 border-t border-border-main bg-bg-menu p-3 text-text-primary">
      <div className="flex items-center gap-2 text-sm font-semibold"><Landmark className="size-4 text-icon-blue" /> {t('Financial analysis')}</div>
      <p className="text-xs text-text-tertiary">{t('All numbers are computed locally from your inputs — no market data is fetched.')}</p>
      <DcfForm />
      <MultiplesForm />
      <StatementsForm />
      <AuditForm />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" loading={reportBusy} onClick={() => void downloadSampleReport()}>
          <Download className="size-4" /> {t('Sample DCF PDF (Typst)')}
        </Button>
        {notice && <span className="text-xs text-text-secondary">{notice}</span>}
      </div>
    </section>
  );
}
