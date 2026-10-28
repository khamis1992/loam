import type { SealedLegalPayload } from "./transcriptSeal.js";

export interface LegalProtection {
  seal(value: unknown, aad: string): SealedLegalPayload;
  open<T>(payload: unknown): T;
}

let current: LegalProtection | null = null;
const legalSessions = new Set<string>();

export function configureLegalProtection(protection: LegalProtection): void {
  current = protection;
}

export function clearLegalProtection(): void {
  current = null;
  legalSessions.clear();
}

export function legalProtection(): LegalProtection {
  if (!current) throw new Error("legal protection is unavailable");
  return current;
}

export function hasLegalProtection(): boolean {
  return current !== null;
}

export function markLegalSession(sessionId: string): void {
  if (sessionId) legalSessions.add(sessionId);
}

export function isLegalSession(sessionId: string): boolean {
  return legalSessions.has(sessionId);
}
