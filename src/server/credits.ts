import crypto from "node:crypto";
import { database, transaction } from "./sqliteStore.js";

/**
 * Local mock credit ledger (OPD option #9).
 *
 * Everything here is LOCAL + MOCK: no payment processing, no charging.
 * A real deployment would back this with a billing provider (see docs/handoff).
 */

export type CreditKind = "grant" | "usage" | "referral" | "purchase_mock";
export type CreditPlan = "free" | "pro";

export interface CreditLedgerEntry {
  id: string;
  kind: CreditKind;
  /** Signed amount: grants/purchases positive, usage negative. */
  amount: number;
  balance_after: number;
  /** Logical reference, unique per entry (drives idempotency). */
  ref: string;
  created_at: string;
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export const STARTING_GRANT = 1000;
export const REFERRAL_BONUS = 500;
export const FLAT_USAGE_CREDITS = 10;
export const TOKENS_PER_CREDIT = 1000;

export const MOCK_PACKS: Record<string, number> = {
  starter: 1_000,
  boost: 5_000,
  mega: 20_000,
};

const PLAN_KEY = "credits-plan";
const REFERRAL_CODE_KEY = "referral-code";
const REFERRAL_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

let initialized = false;

function ensureInit(): void {
  if (initialized) return;
  transaction(() => {
    const db = database();
    db.exec(`CREATE TABLE IF NOT EXISTS credit_ledger (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      ref TEXT NOT NULL,
      created_at TEXT NOT NULL
    ); CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_ref ON credit_ledger(ref);`);
    const row = db.prepare("SELECT COUNT(*) AS n FROM credit_ledger").get() as { n: number };
    if (row.n === 0) {
      insertLocked("grant", STARTING_GRANT, "signup-grant");
    }
  });
  initialized = true;
}

function newEntryId(): string {
  return `cl_${Date.now().toString(36)}${crypto.randomBytes(6).toString("hex")}`;
}

/** Insert assuming we already hold the transaction lock. */
function insertLocked(kind: CreditKind, amount: number, ref: string): CreditLedgerEntry {
  const db = database();
  const balance = currentBalanceLocked();
  const entry: CreditLedgerEntry = {
    id: newEntryId(),
    kind,
    amount,
    balance_after: balance + amount,
    ref,
    created_at: new Date().toISOString(),
  };
  db.prepare("INSERT INTO credit_ledger(id,kind,amount,balance_after,ref,created_at) VALUES(?,?,?,?,?,?)")
    .run(entry.id, entry.kind, entry.amount, entry.balance_after, entry.ref, entry.created_at);
  return entry;
}

function currentBalanceLocked(): number {
  const row = database().prepare("SELECT COALESCE(SUM(amount),0) AS total FROM credit_ledger").get() as { total: number };
  return Math.round(Number(row.total) || 0);
}

function refExistsLocked(ref: string): boolean {
  const row = database().prepare("SELECT 1 FROM credit_ledger WHERE ref=? LIMIT 1").get(ref);
  return Boolean(row);
}

function getMeta(key: string): string | undefined {
  const row = database().prepare("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | undefined;
  return row?.value;
}

function setMeta(key: string, value: string): void {
  database().prepare("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

/** Append a signed amount to the ledger atomically. Fails on duplicate ref. */
export function addCredits(kind: CreditKind, amount: number, ref: string): CreditLedgerEntry {
  if (!Number.isSafeInteger(amount) || amount === 0) throw new Error("credit amount must be a non-zero integer");
  ensureInit();
  return transaction(() => {
    if (refExistsLocked(ref)) throw new Error(`duplicate credit ref: ${ref}`);
    return insertLocked(kind, amount, ref);
  });
}

export function getBalance(): number {
  ensureInit();
  return transaction(() => currentBalanceLocked());
}

export function listLedger(limit = 100): CreditLedgerEntry[] {
  ensureInit();
  const rows = database().prepare(
    "SELECT id, kind, amount, balance_after, ref, created_at FROM credit_ledger ORDER BY rowid DESC LIMIT ?",
  ).all(Math.max(1, Math.min(1000, Math.floor(limit)))) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    kind: String(r.kind) as CreditKind,
    amount: Number(r.amount),
    balance_after: Number(r.balance_after),
    ref: String(r.ref),
    created_at: String(r.created_at),
  }));
}

export function getPlan(): CreditPlan {
  ensureInit();
  const plan = getMeta(PLAN_KEY);
  return plan === "pro" ? "pro" : "free";
}

/** Mock plan switch. No charge happens; see the plan dialog "Test mode" label. */
export function setPlan(plan: CreditPlan): CreditPlan {
  if (plan !== "free" && plan !== "pro") throw new Error(`unknown plan: ${plan}`);
  ensureInit();
  transaction(() => setMeta(PLAN_KEY, plan));
  return getPlan();
}

/**
 * Estimate the credit cost of one completed task from its token usage.
 * Falls back to a flat 10 credits when no token data is available.
 */
export function estimateUsageCredits(usage?: TokenUsage): number {
  const tokens = (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0);
  if (!Number.isFinite(tokens) || tokens <= 0) return FLAT_USAGE_CREDITS;
  return Math.max(1, Math.ceil(tokens / TOKENS_PER_CREDIT));
}

/**
 * Minimal completion hook: record one usage entry per completed task.
 * Idempotent per task (ref = task:<id>) and never throws, so finishing a
 * task can't fail because of bookkeeping.
 */
export function recordTaskUsage(taskId: string, usage?: TokenUsage): CreditLedgerEntry | undefined {
  try {
    return addCredits("usage", -estimateUsageCredits(usage), `task:${taskId}`);
  } catch {
    return undefined; // duplicate ref (task already billed) or transient store issue
  }
}

/** Mock credit pack purchase. Clearly a mock: no payment provider is involved. */
export function purchaseMock(pack: string): CreditLedgerEntry {
  const credits = MOCK_PACKS[pack];
  if (!credits) throw new Error(`unknown pack: ${pack}`);
  return addCredits("purchase_mock", credits, `purchase:mock:${pack}:${crypto.randomUUID()}`);
}

/** Stable per-install referral code, created on first use. */
export function getOrCreateReferralCode(): string {
  ensureInit();
  return transaction(() => {
    const existing = getMeta(REFERRAL_CODE_KEY);
    if (existing) return existing;
    const bytes = crypto.randomBytes(6);
    let code = "";
    for (let i = 0; i < 6; i++) code += REFERRAL_ALPHABET[bytes[i]! % REFERRAL_ALPHABET.length];
    const full = `LOAM-${code}`;
    setMeta(REFERRAL_CODE_KEY, full);
    return full;
  });
}

export interface ReferralRedeemResult {
  balance: number;
  added: number;
  alreadyRedeemed: boolean;
  code: string;
}

/**
 * Redeem a referral code: +500 for the redeemer (local side of the
 * "+500 each side" flow; in production the code owner's +500 is granted
 * server-side when the friend signs up).
 * Idempotent: redeeming the same code twice never credits twice.
 */
export function redeemReferral(code: string): ReferralRedeemResult {
  const normalized = code.trim().toUpperCase();
  if (!normalized) throw new Error("referral code is required");
  ensureInit();
  const own = getOrCreateReferralCode();
  if (normalized === own) throw new Error("cannot redeem your own referral code");
  return transaction(() => {
    const ref = `referral:redeem:${normalized}`;
    if (refExistsLocked(ref)) {
      return { balance: currentBalanceLocked(), added: 0, alreadyRedeemed: true, code: normalized };
    }
    insertLocked("referral", REFERRAL_BONUS, ref);
    return { balance: currentBalanceLocked(), added: REFERRAL_BONUS, alreadyRedeemed: false, code: normalized };
  });
}

/** Test helper: wipe the ledger + plan so each test starts clean. */
export function resetCreditsForTests(): void {
  initialized = false;
  const db = database();
  db.exec("DROP TABLE IF EXISTS credit_ledger");
  db.prepare("DELETE FROM metadata WHERE key IN ('credits-plan','referral-code')").run();
}