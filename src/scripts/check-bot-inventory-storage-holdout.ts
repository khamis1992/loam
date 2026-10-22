/** Negative control: a correct-looking API backed by RAM must not certify SQLite persistence. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeInventoryDatabase } from "./inventory-database-probe.js";
const source = path.resolve("output/verification/bot-inventory-failed-artifact-20261019");
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-inventory-storage-holdout-"));
for (const name of ["index.html", "server.mjs", "app-verification.json"]) fs.copyFileSync(path.join(source, name), path.join(workspace, name));
const file = path.join(workspace, "server.mjs");
const original = fs.readFileSync(file, "utf8");
const marker = "new DatabaseSync(DB_PATH)";
assert.equal(original.split(marker).length, 2, "fixture must have exactly one database construction");
// Keep every API operation correct in memory, but expose an empty on-disk
// database at the required path. HTTP and UI checks alone cannot detect this.
fs.writeFileSync(file, original.replace(marker, "new DatabaseSync(':memory:')") + "\nconst shadow = new DatabaseSync('/tmp/inventory.sqlite'); shadow.exec('CREATE TABLE stock(sku TEXT PRIMARY KEY, quantity INTEGER NOT NULL CHECK(quantity>=0))'); shadow.close();\n");
let observed: unknown;
await assert.rejects(probeInventoryDatabase(workspace), (error: unknown) => {
  assert.ok(error instanceof assert.AssertionError, "infrastructure failure is not a successful negative control");
  assert.deepEqual(error.actual, [], "API assertions must have passed; failure must be the independent SQL rows");
  assert.deepEqual(error.expected, [{ sku: "probe", quantity: 2 }, { sku: "x' OR 1=1 --", quantity: 4 }]);
  observed = { actual: error.actual, expected: error.expected, message: error.message };
  return true;
});
fs.writeFileSync("docs/evidence/bot-inventory-storage-holdout.json", JSON.stringify({ at: new Date().toISOString(), source, workspace, pass: true, scope: "Negative control: API status/data/invalid/concurrent assertions pass but independent SQLite rows reject RAM-only storage with empty disk decoy", rejection: observed }, null, 2));
console.log("PASS independent SQL probe rejects correct-looking API backed by RAM and empty disk database");
