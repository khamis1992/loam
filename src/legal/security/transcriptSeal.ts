import type { FieldCipher } from "../crypto.js";

export const LEGAL_SEALED_MARKER = "loam-legal-sealed/v1";

export interface SealedLegalPayload {
  marker: typeof LEGAL_SEALED_MARKER;
  aad: string;
  ciphertext: string;
}

export function sealLegalPayload(cipher: FieldCipher, value: unknown, aad: string): SealedLegalPayload {
  return { marker: LEGAL_SEALED_MARKER, aad, ciphertext: cipher.sealJson(value, aad) };
}

export function isSealedLegalPayload(value: unknown): value is SealedLegalPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<SealedLegalPayload>;
  return v.marker === LEGAL_SEALED_MARKER && typeof v.aad === "string" && typeof v.ciphertext === "string";
}

export function openLegalPayload<T>(cipher: FieldCipher, value: unknown): T {
  if (!isSealedLegalPayload(value)) throw new Error("legal payload is not sealed");
  return cipher.openJson<T>(value.ciphertext, value.aad);
}
