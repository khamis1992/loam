/** Finance + Typst clients (blueprint §7.5/§7.3): thin wrappers over the local
 *  engines. Pure computation endpoints — no external feeds, no storage. */
import { getApiBase, getApiHeaders, getLoamAuthHeaders } from '@/services/rpc';

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${getApiBase()}${path}`, {
    method: 'POST',
    headers: { ...(await getApiHeaders()), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data as T;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${getApiBase()}${path}`, { headers: await getApiHeaders() });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data as T;
}

export interface DcfInput { cashFlows: number[]; discountRate: number; terminalGrowth: number; netCash?: number }
export interface DcfResult {
  discountedFlows: Array<{ year: number; flow: number; presentValue: number }>;
  terminalValue: number; terminalPresentValue: number; enterpriseValue: number; equityValue: number;
}
export interface MultiplesEntry { name: string; pe?: number; evEbitda?: number; revenueGrowth?: number }
export interface MultiplesResult { medianPe: number | null; medianEvEbitda: number | null; table: MultiplesEntry[] }
export interface LedgerEntry { id: string; kind: 'invoice' | 'payment' | 'contract'; party: string; amount: number; date: string; contractId?: string }
export interface AuditFinding { severity: 'high' | 'medium'; code: string; message: string; entryIds: string[] }
export interface StatementYear { year: number; revenue: number; netIncome: number; currentAssets: number; currentLiabilities: number }
export interface RatiosResult { rows: Array<{ year: number; netMargin: number; currentRatio: number; revenueGrowth: number | null }> }

export const financeApi = {
  status: () => get<{ ok: boolean; capabilities: string[] }>('/api/finance/status'),
  dcf: (input: DcfInput) => post<{ result: DcfResult }>('/api/finance/dcf', input),
  multiples: (entries: MultiplesEntry[]) => post<{ result: MultiplesResult }>('/api/finance/multiples', { entries }),
  statements: (years: StatementYear[]) => post<{ result: RatiosResult }>('/api/finance/statements', { years }),
  audit: (entries: LedgerEntry[], duplicateWindowDays?: number) =>
    post<{ result: { findings: AuditFinding[] } }>('/api/finance/audit', { entries, duplicateWindowDays }),
};

export interface TypstStatus { installed: boolean; version: string | null; path: string | null }

export const typstApi = {
  status: () => get<TypstStatus>('/api/office/typst/status'),
  /** Compiles markup to a PDF Blob for download/preview. */
  compilePdf: async (source: string): Promise<Blob> => {
    const response = await fetch(`${getApiBase()}/api/office/typst/compile`, {
      method: 'POST',
      headers: { ...getLoamAuthHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ source }),
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(detail.error ?? `HTTP ${response.status}`);
    }
    return response.blob();
  },
};
