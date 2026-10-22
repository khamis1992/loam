import fs from "node:fs";
import { probeInventoryDatabase } from "./inventory-database-probe.js";
const previous = JSON.parse(fs.readFileSync("docs/evidence/bot-inventory-reverification.json", "utf8"));
const evidence: Record<string, unknown> = { at: new Date().toISOString(), workspace: previous.workspace, sourceHashes: previous.sourceHashes, pass: false };
try { evidence.probe = await probeInventoryDatabase(previous.workspace); evidence.pass = true; console.log("PASS actual generated inventory: independent SQLite rows, competing withdrawals, invalid input and cleanup"); }
catch (error) { evidence.error = String(error); process.exitCode = 1; console.error(String(error)); }
finally { fs.writeFileSync("docs/evidence/bot-inventory-database.json", JSON.stringify(evidence, null, 2)); }
