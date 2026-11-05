import type { ToolResult } from "../tools/registry.js";

export class PackTimeoutError extends Error {
  readonly code = "timeout" as const;
  readonly retry = false as const;

  constructor(timeoutMs: number) {
    super(`pack operation exceeded ${timeoutMs}ms`);
    this.name = "PackTimeoutError";
  }
}

export async function withPackTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PackTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function packErrorResult(error: unknown): ToolResult {
  if (error instanceof PackTimeoutError) {
    return { ok: false, content: JSON.stringify({ code: error.code, message: error.message, retry: error.retry }) };
  }
  throw error;
}
