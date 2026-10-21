import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";

import type { CreditLedgerEntry, TokenUsage } from "../credits.js";

let tmpDir = "";
let closeDb: () => void;
let resetCreditsForTests: () => void;
let resetAssetsForTests: () => void;
let STARTING_GRANT: number;
let REFERRAL_BONUS: number;
let MOCK_PACKS: Record<string, number>;
let addCredits: (kind: "grant" | "usage" | "referral" | "purchase_mock", amount: number, ref: string) => CreditLedgerEntry;
let getBalance: () => number;
let listLedger: (limit?: number) => CreditLedgerEntry[];
let getPlan: () => "free" | "pro";
let setPlan: (p: "free" | "pro") => "free" | "pro";
let estimateUsageCredits: (usage?: TokenUsage) => number;
let recordTaskUsage: (taskId: string, usage?: TokenUsage) => CreditLedgerEntry | undefined;
let purchaseMock: (pack: string) => CreditLedgerEntry;
let getOrCreateReferralCode: () => string;
let redeemReferral: (code: string) => { balance: number; added: number; alreadyRedeemed: boolean; code: string };
let getAssetsSnapshot: () => unknown;
let injectMockInbound: (input: { from: string; subject: string; body: string }) => { id: string; to: string; from: string; subject: string; body: string; receivedAt: string };
let handleCreditsRoutes: (req: http.IncomingMessage, res: http.ServerResponse, p: string) => Promise<boolean>;
let handleAssetsRoutes: (req: http.IncomingMessage, res: http.ServerResponse, p: string) => Promise<boolean>;

async function request(server: http.Server, method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}


async function startRouteServer(): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const p = new URL(req.url ?? "/", "http://test").pathname;
    if (await handleCreditsRoutes(req, res, p)) return;
    if (await handleAssetsRoutes(req, res, p)) return;
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return server;
}
describe("credits ledger", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-credits-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    const credits = await import("../credits.js");
    const assets = await import("../assets.js");
    const routesCredits = await import("../routes/credits.js");
    const routesAssets = await import("../routes/assets.js");
    resetCreditsForTests = credits.resetCreditsForTests;
    resetAssetsForTests = assets.resetAssetsForTests;
    STARTING_GRANT = credits.STARTING_GRANT;
    REFERRAL_BONUS = credits.REFERRAL_BONUS;
    MOCK_PACKS = credits.MOCK_PACKS;
    addCredits = credits.addCredits;
    getBalance = credits.getBalance;
    listLedger = credits.listLedger;
    getPlan = credits.getPlan;
    setPlan = credits.setPlan;
    estimateUsageCredits = credits.estimateUsageCredits;
    recordTaskUsage = credits.recordTaskUsage;
    purchaseMock = credits.purchaseMock;
    getOrCreateReferralCode = credits.getOrCreateReferralCode;
    redeemReferral = credits.redeemReferral;
    getAssetsSnapshot = assets.getAssetsSnapshot;
    injectMockInbound = assets.injectMockInbound;
    handleCreditsRoutes = routesCredits.handleCreditsRoutes;
    handleAssetsRoutes = routesAssets.handleAssetsRoutes;
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("starts with a signup grant of 1000 credits", () => {
    resetCreditsForTests();
    assert.equal(STARTING_GRANT, 1000);
    assert.equal(getBalance(), 1000);
    const [first] = listLedger(1);
    assert.ok(first);
    assert.equal(first.kind, "grant");
    assert.equal(first.ref, "signup-grant");
    assert.equal(first.amount, 1000);
    assert.equal(first.balance_after, 1000);
  });

  it("tracks balance_after correctly for signed amounts", () => {
    resetCreditsForTests();
    addCredits("grant", 250, "test-grant-a");
    assert.equal(getBalance(), 1250);
    addCredits("usage", -60, "test-usage-a");
    assert.equal(getBalance(), 1190);
    const ledger = listLedger();
    assert.equal(ledger[0]?.balance_after, 1190);
    assert.equal(ledger[1]?.balance_after, 1250);
    // Every entry's balance_after = previous balance_after + amount
    for (let i = 0; i < ledger.length - 1; i++) {
      assert.equal(ledger[i]?.balance_after, (ledger[i + 1]?.balance_after ?? 0) + (ledger[i]?.amount ?? 0));
    }
  });

  it("rejects duplicate refs and non-integer amounts", () => {
    resetCreditsForTests();
    addCredits("grant", 100, "dup-test");
    assert.throws(() => addCredits("grant", 100, "dup-test"), /duplicate credit ref/);
    assert.throws(() => addCredits("grant", 5.5, "frac-test"), /non-zero integer/);
    assert.throws(() => addCredits("grant", 0, "zero-test"), /non-zero integer/);
    assert.equal(getBalance(), 1100);
  });

  it("estimates usage credits from tokens with a flat fallback", () => {
    assert.equal(estimateUsageCredits(undefined), 10);
    assert.equal(estimateUsageCredits({}), 10);
    assert.equal(estimateUsageCredits({ promptTokens: 500, completionTokens: 499 }), 1);
    assert.equal(estimateUsageCredits({ promptTokens: 1000, completionTokens: 0 }), 1);
    assert.equal(estimateUsageCredits({ promptTokens: 1500, completionTokens: 500 }), 2);
    assert.equal(estimateUsageCredits({ promptTokens: 0, completionTokens: 1 }), 1);
    assert.equal(estimateUsageCredits({ promptTokens: -5, completionTokens: -5 }), 10);
  });

  it("records at most one usage entry per completed task", () => {
    resetCreditsForTests();
    const before = getBalance();
    const entry = recordTaskUsage("task-1", { promptTokens: 4500, completionTokens: 500 });
    assert.ok(entry);
    assert.equal(entry.kind, "usage");
    assert.equal(entry.amount, -5);
    assert.equal(entry.ref, "task:task-1");
    assert.equal(getBalance(), before - 5);
    assert.equal(recordTaskUsage("task-1", { promptTokens: 4500, completionTokens: 500 }), undefined);
    assert.equal(getBalance(), before - 5);
    assert.equal(listLedger().filter((e) => e.ref === "task:task-1").length, 1);
    // flat fallback when no token usage is available
    const entry2 = recordTaskUsage("task-2");
    assert.ok(entry2);
    assert.equal(entry2.amount, -10);
  });

  it("mock purchases add pack credits", () => {
    resetCreditsForTests();
    const before = getBalance();
    const entry = purchaseMock("starter");
    assert.equal(entry.kind, "purchase_mock");
    assert.equal(entry.amount, 1000);
    assert.ok(entry.ref.startsWith("purchase:mock:starter:"));
    assert.equal(getBalance(), before + 1000);
    assert.throws(() => purchaseMock("unlimited"), /unknown pack/);
    assert.deepEqual(Object.keys(MOCK_PACKS).sort(), ["boost", "mega", "starter"]);
  });

  it("redeems a referral code once (+500) and is idempotent", () => {
    resetCreditsForTests();
    assert.equal(REFERRAL_BONUS, 500);
    const before = getBalance();
    const own = getOrCreateReferralCode();
    assert.match(own, /^LOAM-[A-Z2-9]{6}$/);
    assert.ok(own !== "LOAM-FRIEND1");
    const first = redeemReferral("LOAM-FRIEND1");
    assert.equal(first.added, 500);
    assert.equal(first.alreadyRedeemed, false);
    assert.equal(first.balance, before + 500);
    assert.equal(getBalance(), before + 500);
    const second = redeemReferral("LOAM-FRIEND1");
    assert.equal(second.added, 0);
    assert.equal(second.alreadyRedeemed, true);
    assert.equal(second.balance, before + 500);
    assert.equal(getBalance(), before + 500);
    assert.equal(listLedger().filter((e) => e.kind === "referral").length, 1);
  });

  it("normalizes case/whitespace for redemption", () => {
    resetCreditsForTests();
    getOrCreateReferralCode();
    assert.equal(redeemReferral("  loam-friend2  ").added, 500);
    const again = redeemReferral("LOAM-FRIEND2");
    assert.equal(again.alreadyRedeemed, true);
    assert.equal(again.added, 0);
  });

  it("refuses to redeem your own code or an empty code", () => {
    resetCreditsForTests();
    const own = getOrCreateReferralCode();
    assert.throws(() => redeemReferral(own), /your own/);
    assert.throws(() => redeemReferral("   "), /required/);
    assert.equal(getBalance(), 1000);
  });

  it("switches plans locally (mock)", () => {
    resetCreditsForTests();
    assert.equal(getPlan(), "free");
    assert.equal(setPlan("pro"), "pro");
    assert.equal(getPlan(), "pro");
    assert.throws(() => setPlan("enterprise" as "pro"), /unknown plan/);
  });

  it("GET /api/credits returns balance, plan and ledger", async () => {
    resetCreditsForTests();
    const server = await startRouteServer();
    try {
      const { status, json } = await request(server, "GET", "/api/credits");
      assert.equal(status, 200);
      assert.equal(json.balance, 1000);
      assert.equal(json.plan, "free");
      assert.ok(Array.isArray(json.ledger));
      assert.equal((json.ledger as CreditLedgerEntry[])[0]?.ref, "signup-grant");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("referral routes are idempotent over HTTP", async () => {
    resetCreditsForTests();
    const server = await startRouteServer();
    try {
      const mine = await request(server, "POST", "/api/referrals");
      assert.equal(mine.status, 200);
      const code = String(mine.json.code);
      assert.match(code, /^LOAM-/);
      assert.ok(String(mine.json.link).includes(`/referral/${code}`));

      const before = await request(server, "GET", "/api/credits");
      const baseBalance = Number(before.json.balance);
      const redeem1 = await request(server, "POST", "/api/referrals/redeem", { code: "LOAM-HTTPFR" });
      assert.equal(redeem1.status, 200);
      assert.equal(redeem1.json.added, 500);
      assert.equal(redeem1.json.balance, baseBalance + 500);
      const redeem2 = await request(server, "POST", "/api/referrals/redeem", { code: "LOAM-HTTPFR" });
      assert.equal(redeem2.status, 200);
      assert.equal(redeem2.json.alreadyRedeemed, true);
      assert.equal(redeem2.json.balance, baseBalance + 500);
      const selfRedeem = await request(server, "POST", "/api/referrals/redeem", { code });
      assert.equal(selfRedeem.status, 400);
      const badRedeem = await request(server, "POST", "/api/referrals/redeem", {});
      assert.equal(badRedeem.status, 400);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("mock purchase route validates packs and credits the ledger", async () => {
    resetCreditsForTests();
    const server = await startRouteServer();
    try {
      const bad = await request(server, "POST", "/api/credits/purchase-mock", { pack: "infinite" });
      assert.equal(bad.status, 400);
      const good = await request(server, "POST", "/api/credits/purchase-mock", { pack: "boost" });
      assert.equal(good.status, 200);
      assert.equal(good.json.mock, true);
      assert.equal((good.json.entry as CreditLedgerEntry).kind, "purchase_mock");
      assert.equal(good.json.balance, 6000);
      const plan = await request(server, "POST", "/api/credits/plan", { plan: "pro" });
      assert.equal(plan.status, 200);
      assert.equal(plan.json.plan, "pro");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("assets route serves mock email/phone/wallet and a mock inbox", async () => {
    resetCreditsForTests();
    resetAssetsForTests();
    const server = await startRouteServer();
    try {
      const first = await request(server, "GET", "/api/assets");
      assert.equal(first.status, 200);
      const email = first.json.email as { address: string; realProvider: string; inbox: unknown[] };
      const phone = first.json.phone as { number: string; realProvider: string };
      const wallet = first.json.wallet as { balance: number; currency: string; realProvider: string };
      assert.match(email.address, /^loam-[a-z2-9]{8}@mock\.local$/);
      assert.ok(email.realProvider.length > 0);
      assert.match(phone.number, /^\+1 \(555\) 01/);
      assert.equal(wallet.currency, "credits");
      assert.equal(wallet.balance, 1000);
      assert.equal(email.inbox.length, 0);

      const injected = await request(server, "POST", "/api/assets/email/mock-inbound", {
        from: "friend@example.test", subject: "Hi Loam", body: "hello",
      });
      assert.equal(injected.status, 200);
      assert.equal((injected.json.message as { to: string }).to, email.address);
      const bad = await request(server, "POST", "/api/assets/email/mock-inbound", { subject: "no from" });
      assert.equal(bad.status, 400);

      const second = await request(server, "GET", "/api/assets");
      const inbox = (second.json.email as { inbox: { subject: string }[] }).inbox;
      assert.equal(inbox.length, 1);
      assert.equal(inbox[0]?.subject, "Hi Loam");
      // Snapshot helper matches the route payload
      const snap = getAssetsSnapshot() as { email: { inbox: unknown[] }; phone: { number: string } };
      assert.equal(snap.email.inbox.length, 1);
      assert.equal(snap.phone.number, phone.number);
      injectMockInbound({ from: "a@b.test", subject: "s2", body: "b2" });
      assert.equal((getAssetsSnapshot() as { email: { inbox: unknown[] } }).email.inbox.length, 2);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
