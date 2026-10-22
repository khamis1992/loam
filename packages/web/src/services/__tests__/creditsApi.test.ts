import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchCredits,
  purchaseMockCredits,
  setMockPlan,
  createReferral,
  redeemReferralCode,
  fetchAssets,
  injectMockInboundEmail,
} from '../creditsApi.js';

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

let calls: Call[] = [];

function stubFetch(handler: (call: Call) => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      const call: Call = { url, method, body };
      calls.push(call);
      return handler(call);
    }) as unknown as typeof fetch,
  );
}

describe('creditsApi', () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reads the credits snapshot: balance, plan, ledger and referral', async () => {
    stubFetch(() =>
      jsonResponse({
        balance: 750,
        plan: 'free',
        ledger: [
          {
            id: 'l1',
            kind: 'grant',
            amount: 1000,
            balance_after: 1000,
            ref: 'signup',
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ],
        referral: { code: 'REF1', link: 'https://x.test/ref/REF1', bonus: 500 },
      }),
    );
    const snap = await fetchCredits();
    expect(snap.balance).toBe(750);
    expect(snap.plan).toBe('free');
    expect(snap.ledger[0]).toMatchObject({ kind: 'grant', amount: 1000, balance_after: 1000 });
    expect(snap.referral).toMatchObject({ code: 'REF1', bonus: 500 });
    expect(calls.some((c) => c.method === 'GET' && c.url.includes('/api/credits'))).toBe(true);
  });

  it('posts a mock purchase pack', async () => {
    stubFetch(() => jsonResponse({ balance: 1000, plan: 'free', entry: { id: 'e1' }, mock: true }));
    await purchaseMockCredits('starter');
    const post = calls.find((c) => c.url.includes('/api/credits/purchase-mock'));
    expect(post).toBeTruthy();
    expect(post!.method).toBe('POST');
    expect(post!.body).toEqual({ pack: 'starter' });
  });

  it('sets the plan', async () => {
    stubFetch(() => jsonResponse({ plan: 'pro', balance: 1000, mock: true }));
    await setMockPlan('pro');
    const post = calls.find((c) => c.url.includes('/api/credits/plan'));
    expect(post!.method).toBe('POST');
    expect(post!.body).toEqual({ plan: 'pro' });
  });

  it('creates and redeems referral codes', async () => {
    stubFetch((c) =>
      c.url.includes('/api/referrals/redeem')
        ? jsonResponse({ balance: 1500, added: 500, alreadyRedeemed: false, code: 'REF1' })
        : jsonResponse({ code: 'REF1', link: 'https://x.test/ref/REF1' }),
    );
    const created = await createReferral();
    expect(created).toMatchObject({ code: 'REF1' });
    const redeemed = await redeemReferralCode('ref1');
    expect(redeemed).toMatchObject({ added: 500, alreadyRedeemed: false });
    expect(calls.find((c) => c.url.includes('/api/referrals/redeem'))!.body).toEqual({ code: 'ref1' });
  });

  it('reads assets and injects a mock inbound email', async () => {
    stubFetch((c) =>
      c.url.includes('/api/assets/email/mock-inbound')
        ? jsonResponse({
            message: { id: 'm1', to: 'a@b.c', from: 'x@y.z', subject: 'hi', body: 'yo', receivedAt: 'now' },
            mock: true,
          })
        : jsonResponse({
            email: { provider: 'mock', address: 'a@b.c', inbox: [], realProvider: 'mock' },
            phone: {},
            wallet: {},
          }),
    );
    const assets = await fetchAssets();
    expect(assets.email.provider).toBe('mock');
    const injected = await injectMockInboundEmail({ from: 'x@y.z', subject: 'hi', body: 'yo' });
    expect(injected.message.id).toBe('m1');
    expect(calls.find((c) => c.url.includes('/api/assets/email/mock-inbound'))!.body).toEqual({
      from: 'x@y.z',
      subject: 'hi',
      body: 'yo',
    });
  });

  it('throws the server error message on failure', async () => {
    stubFetch(() => jsonResponse({ error: 'bad pack' }, 400));
    await expect(purchaseMockCredits('nope')).rejects.toThrow('bad pack');
  });

  it('falls back to the status code when the body has no message', async () => {
    stubFetch(() => jsonResponse({}, 500));
    await expect(fetchCredits()).rejects.toThrow('500');
  });
});
