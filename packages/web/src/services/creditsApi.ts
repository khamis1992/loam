import { getApiBase } from './rpc';

export type CreditKind = 'grant' | 'usage' | 'referral' | 'purchase_mock';
export type CreditPlan = 'free' | 'pro';

export interface CreditLedgerEntry {
  id: string;
  kind: CreditKind;
  amount: number;
  balance_after: number;
  ref: string;
  created_at: string;
}

export interface ReferralInfo {
  code: string;
  link: string;
}

export interface CreditsReferral extends ReferralInfo {
  bonus: number;
}

export interface CreditsSnapshot {
  balance: number;
  plan: CreditPlan;
  ledger: CreditLedgerEntry[];
  referral: CreditsReferral;
}

export interface ReferralRedeem {
  balance: number;
  added: number;
  alreadyRedeemed: boolean;
  code: string;
}

export interface InboundEmail {
  id: string;
  to: string;
  from: string;
  subject: string;
  body: string;
  receivedAt: string;
}

export interface AssetsSnapshot {
  email: { provider: string; address: string; inbox: InboundEmail[]; realProvider: string };
  phone: { provider: string; number: string; realProvider: string; connected: boolean };
  wallet: { provider: string; balance: number; currency: string; realProvider: string; placeholder: string; connected: boolean };
}

interface ErrorBody {
  error?: string;
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getApiBase()}${path}`, init);
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (body as ErrorBody).error || `${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

export function fetchCredits(): Promise<CreditsSnapshot> {
  return jsonFetch<CreditsSnapshot>('/api/credits');
}

export function purchaseMockCredits(pack: string): Promise<{ balance: number; plan: CreditPlan; entry: CreditLedgerEntry; mock: boolean }> {
  return jsonFetch('/api/credits/purchase-mock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pack }),
  });
}

export function setMockPlan(plan: CreditPlan): Promise<{ plan: CreditPlan; balance: number; mock: boolean }> {
  return jsonFetch('/api/credits/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan }),
  });
}

export function createReferral(): Promise<ReferralInfo> {
  return jsonFetch<ReferralInfo>('/api/referrals', { method: 'POST' });
}

export function redeemReferralCode(code: string): Promise<ReferralRedeem> {
  return jsonFetch<ReferralRedeem>('/api/referrals/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

export function fetchAssets(): Promise<AssetsSnapshot> {
  return jsonFetch<AssetsSnapshot>('/api/assets');
}

export function injectMockInboundEmail(input: { from: string; subject: string; body: string }): Promise<{ message: InboundEmail; mock: boolean }> {
  return jsonFetch('/api/assets/email/mock-inbound', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function setAssetsEmailAlias(alias: string): Promise<{ address: string; mock: boolean }> {
  return jsonFetch('/api/assets/email/alias', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ alias }),
  });
}

export function setAssetsPhoneNumber(number: string): Promise<{ number: string; mock: boolean }> {
  return jsonFetch('/api/assets/phone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ number }),
  });
}

export function setAssetsWalletPlaceholder(placeholder: string): Promise<{ placeholder: string; mock: boolean }> {
  return jsonFetch('/api/assets/wallet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ placeholder }),
  });
}
