const SECRET_RE =
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|bearer|cookie)\s*[:=]?\s*)([^\s"',;]{6,})/gi;

/** Vault values registered here are ALWAYS redacted — even when they appear
 *  standalone (not preceded by a secret keyword) in any output. */
const vaultValues = new Set<string>();
export function registerSecretValue(value: string): void {
  if (value.length > 0) vaultValues.add(value);
}
export function unregisterSecretValue(value: string): void {
  vaultValues.delete(value);
}

export function redact(input: string): string {
  let out = input.replace(SECRET_RE, (_m: string, p1: string) => `${p1}***`);
  // Standalone vault values: replace any occurrence regardless of context.
  for (const v of vaultValues) {
    if (out.includes(v)) out = out.split(v).join("***");
  }
  return out;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function fmt(v: unknown): string {
  return typeof v === "string" ? redact(v) : redact(safeJson(v));
}

function ts(): string {
  return new Date().toISOString();
}

export const log = {
  info: (...args: unknown[]): void => console.log(`[${ts()}] INFO`, ...args.map(fmt)),
  warn: (...args: unknown[]): void => console.warn(`[${ts()}] WARN`, ...args.map(fmt)),
  error: (...args: unknown[]): void => console.error(`[${ts()}] ERR `, ...args.map(fmt)),
  debug: (...args: unknown[]): void => {
    if (process.env.MANUS_LOCAL_DEBUG) console.log(`[${ts()}] DBG `, ...args.map(fmt));
  },
};
