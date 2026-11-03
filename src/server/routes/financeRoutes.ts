/** Financial engine routes (blueprint §7.5): DCF, multiples, statements and
 *  the mechanical accounting audit. Pure computation over posted payloads —
 *  no external feeds, no storage. */
import http from "node:http";
import { analyzeStatements, auditLedger, compareMultiples, computeDcf, type DcfInput, type LedgerEntry, type MultiplesEntry, type StatementYear } from "../../finance/engine.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 2_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error("body_too_large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("invalid_json")); }
    });
    req.on("error", reject);
  });
}

export async function handleFinanceRoutes(req: http.IncomingMessage, res: http.ServerResponse, p: string): Promise<boolean> {
  if (!p.startsWith("/api/finance/")) return false;

  if (p === "/api/finance/status" && req.method === "GET") {
    sendJson(res, 200, { ok: true, capabilities: ["dcf", "multiples", "statements", "audit"] });
    return true;
  }

  if (p === "/api/finance/dcf" && req.method === "POST") {
    const body = await readJson(req).catch(() => null);
    try {
      sendJson(res, 200, { result: computeDcf(body as unknown as DcfInput) });
    } catch (reason) {
      sendJson(res, 422, { error: reason instanceof Error ? reason.message : String(reason) });
    }
    return true;
  }

  if (p === "/api/finance/multiples" && req.method === "POST") {
    const body = await readJson(req).catch(() => null);
    try {
      const { entries } = body as { entries?: MultiplesEntry[] };
      sendJson(res, 200, { result: compareMultiples(entries ?? []) });
    } catch (reason) {
      sendJson(res, 422, { error: reason instanceof Error ? reason.message : String(reason) });
    }
    return true;
  }

  if (p === "/api/finance/statements" && req.method === "POST") {
    const body = await readJson(req).catch(() => null);
    try {
      const { years } = body as { years?: StatementYear[] };
      sendJson(res, 200, { result: analyzeStatements(years ?? []) });
    } catch (reason) {
      sendJson(res, 422, { error: reason instanceof Error ? reason.message : String(reason) });
    }
    return true;
  }

  if (p === "/api/finance/audit" && req.method === "POST") {
    const body = await readJson(req).catch(() => null);
    try {
      const { entries, duplicateWindowDays } = body as { entries?: LedgerEntry[]; duplicateWindowDays?: number };
      sendJson(res, 200, { result: { findings: auditLedger(entries ?? [], duplicateWindowDays) } });
    } catch (reason) {
      sendJson(res, 422, { error: reason instanceof Error ? reason.message : String(reason) });
    }
    return true;
  }

  return false;
}
