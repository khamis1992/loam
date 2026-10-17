const SECRET_RE =
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|bearer|cookie)\s*[:=]?\s*)([^\s"',;]{6,})/gi;

export function redact(input: string): string {
  return input.replace(SECRET_RE, (_m: string, p1: string) => `${p1}***`);
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
