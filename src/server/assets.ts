import crypto from "node:crypto";
import { database, transaction, putEntity, allEntities, removeEntity } from "./sqliteStore.js";
import { getBalance } from "./credits.js";

/**
 * Asset providers (OPD option #8): Email / Phone / Wallet.
 *
 * LOCAL + MOCK ONLY. The interfaces below are the seams a real deployment
 * would fill with external accounts:
 *   - Email: an inbound email provider (Postmark, Amazon SES, Mailgun ...)
 *   - Phone: a telephony provider (Twilio, Vonage ...)
 *   - Wallet: a billing provider (Stripe, Paddle ...)
 * The mock implementations here never send anything and never charge anyone.
 */

export interface InboundEmail {
  id: string;
  to: string;
  from: string;
  subject: string;
  body: string;
  receivedAt: string;
}

export interface EmailProvider {
  readonly id: string;
  /** Which external service would power this in production. */
  readonly realProvider: string;
  getAddress(): string;
  listInbox(): InboundEmail[];
}

export interface PhoneProvider {
  readonly id: string;
  readonly realProvider: string;
  getNumber(): string;
}

export interface WalletProvider {
  readonly id: string;
  readonly realProvider: string;
  getBalance(): { amount: number; currency: string };
}

const EMAIL_ADDRESS_KEY = "mock-email-address";
const PHONE_NUMBER_KEY = "mock-phone-number";
const WALLET_PLACEHOLDER_KEY = "mock-wallet-placeholder";
const EMAIL_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

interface StoredEmail extends InboundEmail {}

function getMeta(key: string): string | undefined {
  const row = database().prepare("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | undefined;
  return row?.value;
}

function setMeta(key: string, value: string): void {
  database().prepare("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

class MockEmailProvider implements EmailProvider {
  readonly id = "mock";
  readonly realProvider = "An inbound email provider (Postmark, Amazon SES, or Mailgun)";

  getAddress(): string {
    return transaction(() => {
      const existing = getMeta(EMAIL_ADDRESS_KEY);
      if (existing) return existing;
      const bytes = crypto.randomBytes(8);
      let id = "";
      for (let i = 0; i < 8; i++) id += EMAIL_ALPHABET[bytes[i]! % EMAIL_ALPHABET.length];
      const address = `loam-${id}@mock.local`;
      setMeta(EMAIL_ADDRESS_KEY, address);
      return address;
    });
  }

  listInbox(): InboundEmail[] {
    return allEntities<StoredEmail>("mock_inbox");
  }
}

class MockPhoneProvider implements PhoneProvider {
  readonly id = "mock";
  readonly realProvider = "A telephony provider (Twilio or Vonage)";

  getNumber(): string {
    return transaction(() => {
      const existing = getMeta(PHONE_NUMBER_KEY);
      if (existing) return existing;
      // 555-01xx is the reserved fictional North American range.
      const n = String(1 + Math.floor(Math.random() * 99)).padStart(2, "0");
      const number = `+1 (555) 01${n.slice(0, 2)}-${String(100 + Math.floor(Math.random() * 900))}`;
      setMeta(PHONE_NUMBER_KEY, number);
      return number;
    });
  }
}

class MockWalletProvider implements WalletProvider {
  readonly id = "mock";
  readonly realProvider = "A billing provider (Stripe or Paddle)";

  getBalance(): { amount: number; currency: string } {
    return { amount: getBalance(), currency: "credits" };
  }
}

export const mockEmailProvider = new MockEmailProvider();
export const mockPhoneProvider = new MockPhoneProvider();
export const mockWalletProvider = new MockWalletProvider();

/** Dev route backing store: inject a fake inbound message into the mock inbox. */
export function injectMockInbound(input: { from: string; subject: string; body: string }): InboundEmail {
  const from = input.from.trim();
  const subject = input.subject.trim();
  const body = input.body.trim();
  if (!from || !subject) throw new Error("from and subject are required");
  const message: InboundEmail = {
    id: `mail_${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`,
    to: mockEmailProvider.getAddress(),
    from: from.slice(0, 200),
    subject: subject.slice(0, 200),
    body: body.slice(0, 5000),
    receivedAt: new Date().toISOString(),
  };
  putEntity("mock_inbox", message);
  return message;
}

/** Replace the auto-generated inbound alias with a user-chosen one. */
export function setEmailAlias(alias: string): string {
  const cleaned = alias.trim();
  if (!cleaned) throw new Error("email alias is required");
  if (cleaned.length > 200) throw new Error("email alias is too long");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) {
    throw new Error("email alias must look like an address (name@example.com)");
  }
  return transaction(() => {
    setMeta(EMAIL_ADDRESS_KEY, cleaned);
    return cleaned;
  });
}

/** Replace the auto-generated number with a user-chosen one. */
export function setPhoneNumber(number: string): string {
  const cleaned = number.trim();
  if (!cleaned) throw new Error("phone number is required");
  if (cleaned.length > 40) throw new Error("phone number is too long");
  return transaction(() => {
    setMeta(PHONE_NUMBER_KEY, cleaned);
    return cleaned;
  });
}

/** Store a billing/wallet placeholder (e.g. a Stripe customer id). Not connected. */
export function setWalletPlaceholder(value: string): string {
  const cleaned = value.trim();
  if (cleaned.length > 200) throw new Error("wallet placeholder is too long");
  return transaction(() => {
    setMeta(WALLET_PLACEHOLDER_KEY, cleaned);
    return cleaned;
  });
}

export function getWalletPlaceholder(): string {
  return getMeta(WALLET_PLACEHOLDER_KEY) ?? "";
}

export interface AssetsSnapshot {
  email: { provider: string; address: string; inbox: InboundEmail[]; realProvider: string };
  phone: { provider: string; number: string; realProvider: string; connected: boolean };
  wallet: { provider: string; balance: number; currency: string; realProvider: string; placeholder: string; connected: boolean };
}

/** GET /api/assets payload. */
export function getAssetsSnapshot(): AssetsSnapshot {
  return {
    email: {
      provider: mockEmailProvider.id,
      address: mockEmailProvider.getAddress(),
      inbox: mockEmailProvider.listInbox().slice(0, 50),
      realProvider: mockEmailProvider.realProvider,
    },
    phone: {
      provider: mockPhoneProvider.id,
      number: mockPhoneProvider.getNumber(),
      realProvider: mockPhoneProvider.realProvider,
      connected: false,
    },
    wallet: {
      provider: mockWalletProvider.id,
      balance: mockWalletProvider.getBalance().amount,
      currency: mockWalletProvider.getBalance().currency,
      realProvider: mockWalletProvider.realProvider,
      placeholder: getWalletPlaceholder(),
      connected: false,
    },
  };
}

/** Test helper: wipe mock assets so each test starts clean. */
export function resetAssetsForTests(): void {
  const db = database();
  db.prepare("DELETE FROM metadata WHERE key IN ('mock-email-address','mock-phone-number','mock-wallet-placeholder')").run();
  for (const m of allEntities<StoredEmail>("mock_inbox")) {
    removeEntity("mock_inbox", m.id);
  }
}