/**
 * Mock legal server for UI work and e2e tests: the REAL route handler over the
 * fictional fixture corpus (years 2088-2095, so nothing can be mistaken for
 * Qatari law), an in-memory matters DB with a throwaway key, and the same
 * x-loam-local-token check as Loam's server.
 *
 *   npx tsx src/scripts/legal-mock-server.ts --port 8799 --token dev-token
 */
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LegalFileVault } from "../legal/security/fileVault.js";
import { importMatterDocument } from "../legal/evidence/service.js";
import { localLegalOcr, closeLegalOcr } from "../legal/evidence/ocr.js";
import { rasterizePdfPage } from "../legal/evidence/pdfRaster.js";
import { createLegalModelPort } from "../legal/model/legalModelPort.js";
import { buildDefensePackage } from "../legal/defense/service.js";
import { StaticKeyProvider } from "../legal/crypto.js";
import { MattersStore } from "../legal/mattersStore.js";
import { loadFixtureCorpus } from "../legal/__tests__/helpers.js";
import { handleLegalRoutes, type LegalRouteContext } from "../server/routes/legal.js";

export interface MockServer { url: string; token: string; ctx: LegalRouteContext; close(): Promise<void> }

export async function startMockServer(port = 0, token = crypto.randomBytes(16).toString("hex"), now?: () => Date): Promise<MockServer> {
  const keys = new StaticKeyProvider(crypto.randomBytes(32));
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-mock-vault-"));
  const ctx: LegalRouteContext = {
    corpus: loadFixtureCorpus(),
    matters: new MattersStore(":memory:", keys, now),
    egress: { localModel: "qwen3.6:35b-a3b", approvedLocalModels: ["qwen3.6:35b-a3b"], ollamaUrl: "http://127.0.0.1:11434" },
    enabled: true,
    keys,
    vault: new LegalFileVault(vaultDir, keys),
    model: createLegalModelPort({ config: { localModel: "qwen3.6:35b-a3b", approvedLocalModels: ["qwen3.6:35b-a3b"], ollamaUrl: "http://127.0.0.1:11434" } }),
    buildDefense: (matterId) => buildDefensePackage(ctx.matters, ctx.corpus, { port: ctx.model.port, config: ctx.egress }, matterId),
    importDocument: (matterId, absPath) => importMatterDocument(ctx.matters, matterId, absPath, { ocr: localLegalOcr, rasterize: rasterizePdfPage, ...(now ? { now } : {}) }),
    ...(now ? { now } : {}),
  };
  const server = http.createServer((req, res) => {
    if (req.headers["x-loam-local-token"] !== token) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthenticated" }));
      return;
    }
    const p = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    void handleLegalRoutes(req, res, p, ctx).then((handled) => {
      if (!handled) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return {
    url: `http://127.0.0.1:${actualPort}`,
    token,
    ctx,
    close: () => new Promise<void>((resolve) => server.close(() => {
      ctx.matters.close(); ctx.corpus.close(); fs.rmSync(vaultDir, { recursive: true, force: true }); void closeLegalOcr(); resolve();
    })),
  };
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const arg = (name: string): string | undefined => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
  const srv = await startMockServer(Number(arg("--port") ?? 8799), arg("--token") ?? "dev-token");
  process.stdout.write(`legal mock server on ${srv.url} (header x-loam-local-token required)\n`);
}
