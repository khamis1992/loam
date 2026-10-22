import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { inScope, type CampaignScope, type RequestEvidence } from "./scope.js";
import { coverageKey } from "./findings.js";
import type { PentestFinding } from "../tools/pentest.js";

// Command injection verification with an out-of-band witness. The operator's
// probe template supplies the shell separator context (for example
// "127.0.0.1 && @LOAM_CMD@"); the engine substitutes an inert canary command —
// exactly one curl to the engine's loopback listener with a fresh token. No
// data is read, no files are touched, no network beyond the engine's own
// listener. Only the target application's shell execution can reach that
// listener, so a tokenized callback proves a command built from user input
// ran. A benign separator-free baseline must be accepted and produce no
// callback before any verdict.

export interface CommandCase {
  id: string;
  path: string;
  field: string;
  benignRef: string;
  templateRef: string;
}
export interface CommandProof {
  id: string; at: string; kind: "command"; caseId: string; target: string;
  outcome: "observed" | "not_observed" | "inconclusive";
  summary: string; requestIds: string[];
  observations: Record<string, string | number | boolean>;
}

const ref = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(v);
const PLACEHOLDER = "@LOAM_CMD@";

export function normalizeCommandCases(value: unknown, scope: CampaignScope, profile: "quick" | "campaign", postPaths: string[]): CommandCase[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.length) return [];
  if (profile !== "campaign") throw Error("Command injection cases require campaign mode");
  if (!scope.seeds.length) throw Error("Command injection cases require a scoped target");
  if (value.length > 5) throw Error("At most five command injection cases");
  const cases = value.map((item): CommandCase => {
    if (!item || typeof item !== "object") throw Error("Command injection case must be an object");
    const raw = item as Record<string, unknown>;
    if (!ref(raw.id) || !ref(raw.benignRef) || !ref(raw.templateRef)) throw Error("Command injection case requires id, benignRef and templateRef");
    if (typeof raw.field !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(raw.field)) throw Error("Command injection case requires a safe JSON field name");
    if (typeof raw.path !== "string" || !raw.path.startsWith("/") || raw.path.startsWith("//") || /[?#%\\]/.test(raw.path) || new URL(raw.path, scope.seeds[0]!).pathname !== raw.path) throw Error("Command injection case requires an exact path without query or fragment");
    if (!inScope(scope, new URL(raw.path, scope.seeds[0]!).href)) throw Error("Command injection case path is outside the approved scope");
    if (!postPaths.includes(raw.path)) throw Error("Command injection POST path must be allowlisted in postPaths");
    return { id: raw.id as string, path: raw.path, field: raw.field, benignRef: raw.benignRef as string, templateRef: raw.templateRef as string };
  });
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw Error("Command injection case ids must be unique");
  return cases;
}

// The benign value and the probe template are operator-supplied, fresh per
// run and never recorded. The template must carry the command placeholder.
export function normalizeCommandValues(value: unknown, cases: CommandCase[]): Record<string, string> {
  if (!cases.length) return {};
  if (value === undefined || !value || typeof value !== "object" || Array.isArray(value)) throw Error("Command injection cases require fresh input: " + cases[0]!.benignRef);
  const values = value as Record<string, unknown>, result: Record<string, string> = {};
  for (const c of cases) {
    for (const key of ["benignRef", "templateRef"] as const) {
      const v = values[c[key]];
      if (v === undefined) throw Error("Supply fresh business input: " + c[key]);
      if (typeof v !== "string" || !v.trim() || v.length > 8192) throw Error("Command injection " + key.replace("Ref", " value") + " must be a nonempty string up to 8192 bytes: " + c[key]);
      result[c[key]] = v;
    }
    if (!result[c.templateRef]!.includes(PLACEHOLDER)) throw Error("Command injection probe template must contain the command placeholder " + PLACEHOLDER + ": " + c.templateRef);
  }
  return result;
}

export type CommandEngineInput = {
  scope: CampaignScope; secrets: Record<string, string>;
  auth: Record<string, string>; signal: AbortSignal; evidence: RequestEvidence[];
  reserve: () => Promise<{ id: string; at: number }>; redact: (value: string) => string;
  result: { proofs: CommandProof[]; incomplete: boolean };
  publish: (proof: CommandProof, findings: PentestFinding[], covered: string[]) => void;
};

export async function runCommandCases(input: CommandEngineInput, cases: CommandCase[]): Promise<void> {
  const { scope, secrets, auth, signal, evidence, reserve, redact, result } = input;
  const hash = (data: string) => createHash("sha256").update(data).digest("hex");
  const scrub = (v: string) => Object.values(secrets).reduce((acc, s) => s ? acc.split(s).join("[REDACTED]") : acc, redact(v));
  // Loopback witness listener: only a command executed by the target can
  // reach it.
  const hits: string[] = [];
  const listener = http.createServer((req, res) => {
    try { hits.push(new URL(req.url ?? "/", "http://127.0.0.1").pathname.replace(/^\//, "")); } catch { /* malformed callback path */ }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  listener.on("connection", socket => socket.on("error", () => socket.destroy()));
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", () => resolve()); });
  const port = (listener.address() as import("node:net").AddressInfo).port;
  const send = async (c: CommandCase, value: string): Promise<number> => {
    const base = new URL(c.path, scope.seeds[0]!).href;
    signal.throwIfAborted();
    if (!inScope(scope, base)) throw Error("Command injection path left the approved scope");
    const ticket = await reserve();
    const started = Date.now(), bodyText = JSON.stringify({ [c.field]: value });
    const item: RequestEvidence = { id: ticket.id, at: new Date(ticket.at).toISOString(), url: base, method: "POST", authenticated: !!Object.keys(auth).length, status: 0, durationMs: 0, bodyHash: "", bytes: 0, contentType: "", engine: "http", requestBytes: Buffer.byteLength(bodyText), postPolicy: c.path };
    evidence.push(item);
    try {
      const res = await fetch(base, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: bodyText, redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
      const chunks: Uint8Array[] = []; let bytes = 0;
      const reader = res.body?.getReader();
      if (reader) try { for (;;) { const part = await reader.read(); if (part.done) break; const chunk = part.value.subarray(0, 32768 - bytes); chunks.push(chunk); bytes += chunk.length; if (chunk.length < part.value.length) break; } } finally { await reader.cancel().catch(() => {}); }
      item.status = res.status; item.bytes = bytes; item.bodyHash = hash(Buffer.concat(chunks).toString("utf8"));
      item.contentType = redact(res.headers.get("content-type")?.split(";")[0] ?? "");
      return res.status;
    } catch (error) {
      item.error = redact("Command injection probe request failed: " + (error instanceof Error ? error.message : String(error)));
      return 0;
    } finally { item.durationMs = Date.now() - started; }
  };
  try {
    for (const c of cases) {
      signal.throwIfAborted();
      const target = new URL(c.path, scope.seeds[0]!).href, offset = evidence.length;
      const proof: CommandProof = { id: randomUUID(), at: new Date().toISOString(), kind: "command", caseId: c.id, target, outcome: "inconclusive", summary: "Command injection verification did not complete", requestIds: [], observations: { field: c.field, witnessPort: port } };
      const finish = (findings: PentestFinding[], covered: string[]) => {
        proof.requestIds = evidence.slice(offset).map(e => e.id);
        if (proof.outcome === "inconclusive") result.incomplete = true;
        result.proofs.push(proof);
        input.publish(proof, findings.map(f => ({ ...f, title: scrub(f.title), detail: scrub(f.detail) })), covered);
      };
      try {
        const benign = secrets[c.benignRef]!, template = secrets[c.templateRef]!;
        const token = randomUUID().replace(/-/g, "").slice(0, 24);
        // Inert canary: one loopback fetch, nothing else. curl ships with
        // Windows 10+ and every common Unix; the URL carries no spaces so it
        // needs no quoting in either shell family.
        const canary = `curl -s http://127.0.0.1:${port}/${token}`;
        const probe = template.split(PLACEHOLDER).join(canary);
        // Negative baseline: the separator-free value must be accepted with
        // no listener callback since this case began.
        const hitsBeforeCase = hits.length;
        const baselineStatus = await send(c, benign);
        proof.observations.baselineStatus = baselineStatus;
        if (!(baselineStatus >= 200 && baselineStatus < 300)) { proof.summary = "Baseline request was not accepted (HTTP " + baselineStatus + "); review the case path, field and benign value"; finish([], []); continue; }
        if (hits.length > hitsBeforeCase) { proof.summary = "Negative control failed: the listener was contacted before the probe; callbacks cannot be attributed"; finish([], []); continue; }
        proof.observations.baselineClean = true;
        const probeStatus = await send(c, probe);
        proof.observations.probeStatus = probeStatus;
        let received = hits.includes(token);
        for (let waited = 0; !received && waited < 3000; waited += 150) {
          await new Promise(resolve => setTimeout(resolve, 150));
          received = hits.includes(token);
        }
        proof.observations.callbackReceived = received;
        const check = "command_" + createHash("sha256").update(c.id).digest("hex").slice(0, 16);
        if (received) {
          proof.outcome = "observed";
          proof.summary = "A command built from user input executed on the host";
          const finding: PentestFinding = {
            id: check, check, verdict: "finding", severity: "critical", target,
            title: "Command injection confirmed by execution witness: " + c.id,
            detail: "After a benign separator-free baseline was accepted with no callback, a probe carrying an inert curl to the engine's loopback listener was submitted through the declared field (HTTP " + probeStatus + "). The chained command executed on the application host and reached the listener with a fresh token — only the application's own shell execution can reach that listener. The canary performs one fetch and nothing else; no data was accessed. This is remote code execution class: any chained command would run the same way.",
            remediation: "Never build shell command strings from user input; use parameterized process execution with an argv array and strict value validation. Re-run this case after repair.",
          };
          finish([finding], [coverageKey(target, check)]);
          continue;
        }
        proof.outcome = "not_observed";
        proof.summary = probeStatus >= 200 && probeStatus < 300
          ? "The probe was accepted but the chained command never executed (input validated, escaped or never reached a shell)"
          : "The probe was rejected (HTTP " + probeStatus + ") and the chained command never executed";
        finish([], [coverageKey(target, check)]);
      } catch (error) {
        signal.throwIfAborted();
        proof.summary = "Command injection case could not be executed: " + scrub(error instanceof Error ? error.message : String(error));
        finish([], []);
      }
    }
  } finally {
    listener.closeAllConnections?.();
    await new Promise<void>(resolve => listener.close(() => resolve()));
  }
}
