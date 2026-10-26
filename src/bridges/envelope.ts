import type { BridgeCommand, BridgeEnvelope } from "./types.js";

const TEXT_CAP = 6000;

function tail(s: string, n: number): string {
  return s.length <= n ? s : `…${s.slice(-n)}`;
}

/** Turn a finished process into one envelope: JSON, `{error,type}`, or text. */
export function toEnvelope(
  cmd: Pick<BridgeCommand, "output">,
  run: { code: number | null; stdout: string; stdoutBuffer?: Buffer; stderr: string; timedOut: boolean },
): BridgeEnvelope {
  const base = { exitCode: run.code, timedOut: run.timedOut };
  if (run.timedOut) {
    return { ...base, ok: false, error: { type: "timeout", message: "the program was killed after the time limit" } };
  }
  if (cmd.output === "base64" && run.code === 0) {
    const bytes = run.stdoutBuffer ?? Buffer.from(run.stdout, "utf8");
    return { ...base, ok: true, text: bytes.toString("base64") };
  }
  if (cmd.output === "jsonl") {
    const items: unknown[] = [];
    for (const line of run.stdout.split(/\r?\n/)) {
      if (!line.trim().startsWith("{")) continue;
      try {
        items.push(JSON.parse(line));
      } catch {
        /* skip non-JSON log lines */
      }
    }
    if (run.code !== 0) {
      const text = [run.stdout.trim(), run.stderr.trim() ? `stderr:\n${run.stderr.trim()}` : ""].filter(Boolean).join("\n");
      return { ...base, ok: false, text: tail(text, TEXT_CAP), error: { type: "exit", message: `exit code ${run.code ?? "null"}` } };
    }
    return { ...base, ok: true, data: items, text: tail(run.stdout, TEXT_CAP) };
  }
  if (cmd.output === "json" && run.stdout.trim()) {
    try {
      const data: unknown = JSON.parse(run.stdout);
      if (data && typeof data === "object" && !Array.isArray(data)) {
        const o = data as Record<string, unknown>;
        if (typeof o.error === "string") {
          return { ...base, ok: false, error: { type: typeof o.type === "string" ? o.type : "error", message: o.error } };
        }
      }
      return { ...base, ok: run.code === 0, data };
    } catch {
      /* not JSON after all: fall through to text */
    }
  }
  const text = [run.stdout.trim(), run.stderr.trim() ? `stderr:\n${run.stderr.trim()}` : ""].filter(Boolean).join("\n");
  if (run.code !== 0) {
    return { ...base, ok: false, text: tail(text, TEXT_CAP), error: { type: "exit", message: `exit code ${run.code ?? "null"}` } };
  }
  return { ...base, ok: true, text: tail(text, TEXT_CAP) };
}

/** Render an envelope as the string the model reads. */
export function formatEnvelope(e: BridgeEnvelope): string {
  const head = `ok=${e.ok} exit=${e.exitCode ?? "null"}${e.timedOut ? " (timeout, killed)" : ""}`;
  const parts = [head];
  if (e.error) parts.push(`error[${e.error.type}]: ${e.error.message}`);
  if (e.data !== undefined) parts.push(tail(JSON.stringify(e.data, null, 1), TEXT_CAP));
  if (e.text) parts.push(e.text);
  return parts.join("\n");
}
