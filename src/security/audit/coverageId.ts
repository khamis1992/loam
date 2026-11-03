/** Deterministic coverage ids derived from a unit's canonical refs. */

const MAX_UNITS = 1024;
// Control (Cc) and format (Cf) characters are never allowed in a ref.
const FORBIDDEN = /[\p{Cc}\p{Cf}]/u;
const UNRESERVED = /[A-Za-z0-9\-._~]/;

export interface CanonicalRefs { surface: string; boundary: string; subsystem: string; attack_class: string; lifecycle?: string }

export function normalizeRef(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "ref must be a string" };
  const v = raw.normalize("NFC");
  if (v.length === 0 || !/\S/u.test(v)) return { ok: false, error: "ref is empty" };
  if (v.length > MAX_UNITS) return { ok: false, error: `ref exceeds ${MAX_UNITS} UTF-16 units` };
  if (FORBIDDEN.test(v)) return { ok: false, error: "ref contains control or format characters" };
  return { ok: true, value: v };
}

/** Percent-encode every UTF-8 byte outside the unreserved set, uppercase hex. */
export function encodeRef(v: string): string {
  let out = "";
  for (const ch of v) {
    if (ch.length === 1 && UNRESERVED.test(ch)) {
      out += ch;
      continue;
    }
    for (const b of Buffer.from(ch, "utf8")) out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

export function deriveCoverageId(refs: CanonicalRefs): string {
  const parts = [refs.surface, refs.boundary, refs.subsystem, refs.attack_class];
  if (refs.lifecycle !== undefined) parts.push(refs.lifecycle);
  const enc = parts.map((p) => {
    const n = normalizeRef(p);
    if (!n.ok) throw new Error(`coverage ref invalid: ${n.error}`);
    return encodeRef(n.value);
  });
  return enc.join("::");
}

export function tryDeriveCoverageId(refs: CanonicalRefs): { ok: true; id: string } | { ok: false; error: string } {
  try {
    return { ok: true, id: deriveCoverageId(refs) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
export const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export function isValidAgentId(id: unknown): id is string {
  return typeof id === "string" && AGENT_ID_RE.test(id) && !DEVICE.test(id);
}
