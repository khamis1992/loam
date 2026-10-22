import http from "node:http";
import {
  MOCK_PACKS,
  REFERRAL_BONUS,
  getBalance,
  getOrCreateReferralCode,
  getPlan,
  listLedger,
  purchaseMock,
  redeemReferral,
  setPlan,
  type CreditPlan,
} from "../credits.js";

function referralInfo(req: http.IncomingMessage): { code: string; link: string; bonus: number } {
  const code = getOrCreateReferralCode();
  const host = req.headers.host ?? "127.0.0.1:3939";
  return { code, link: `http://${host}/referral/${code}`, bonus: REFERRAL_BONUS };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 32_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Credits + referral routes (OPD option #9). LOCAL + MOCK ONLY: no real
 * payment processing, no charging. Mount via http.ts:
 *   if (await handleCreditsRoutes(req, res, p)) return;
 */
export async function handleCreditsRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  if (p === "/api/credits" && req.method === "GET") {
    sendJson(res, 200, { balance: getBalance(), plan: getPlan(), ledger: listLedger(), referral: referralInfo(req) });
    return true;
  }

  if (p === "/api/credits/purchase-mock" && req.method === "POST") {
    const body = (await readJson(req)) as { pack?: unknown };
    const pack = typeof body.pack === "string" ? body.pack.trim() : "";
    if (!MOCK_PACKS[pack]) {
      sendJson(res, 400, { error: `unknown pack: ${pack || "(missing)"}`, packs: Object.keys(MOCK_PACKS) });
      return true;
    }
    const entry = purchaseMock(pack);
    sendJson(res, 200, { balance: getBalance(), plan: getPlan(), entry, mock: true });
    return true;
  }

  if (p === "/api/credits/plan" && req.method === "POST") {
    const body = (await readJson(req)) as { plan?: unknown };
    const plan = body.plan === "pro" || body.plan === "free" ? (body.plan as CreditPlan) : undefined;
    if (!plan) {
      sendJson(res, 400, { error: "plan must be 'free' or 'pro'", plan: getPlan() });
      return true;
    }
    sendJson(res, 200, { plan: setPlan(plan), balance: getBalance(), mock: true });
    return true;
  }

  if (p === "/api/referrals" && req.method === "POST") {
    sendJson(res, 200, referralInfo(req));
    return true;
  }

  if (p === "/api/referrals/redeem" && req.method === "POST") {
    const body = (await readJson(req)) as { code?: unknown };
    if (typeof body.code !== "string" || !body.code.trim()) {
      sendJson(res, 400, { error: "code is required" });
      return true;
    }
    try {
      const result = redeemReferral(body.code);
      sendJson(res, 200, { ...result, mock: true });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  return false;
}