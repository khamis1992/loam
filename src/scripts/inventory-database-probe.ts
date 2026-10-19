import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BackendSandbox } from "../agent/backendSandbox.js";

export async function probeInventoryDatabase(workspace: string) {
  const sandbox = await BackendSandbox.start(workspace, "server.mjs");
  let containerId = "", derivedImage = "";
  let rows: unknown;
  try {
    const state = await sandbox.inspect() as { Id: string; Image: string };
    containerId = state.Id; derivedImage = state.Image;
    const post = (url: string, data: unknown) => sandbox.request(url, "POST", { "content-type": "application/json" }, Buffer.from(JSON.stringify(data)).toString("base64"));
    assert.equal((await post("/api/stock", { sku: "probe", quantity: 10 })).status, 201);
    assert.equal((await post("/api/withdraw", { sku: "probe", quantity: 3 })).status, 200);
    assert.equal((await post("/api/withdraw", { sku: "probe", quantity: 99 })).status, 409);
    assert.equal((await post("/api/stock", { sku: "probe", quantity: 99 })).status, 409);
    for (const quantity of [-1, 0, 1.5]) assert.equal((await post("/api/withdraw", { sku: "probe", quantity })).status, 400);
    assert.equal((await post("/api/stock", { sku: " ", quantity: 3 })).status, 400);
    const quoted = "x' OR 1=1 --";
    assert.equal((await post("/api/stock", { sku: quoted, quantity: 4 })).status, 201);
    const readApi = async () => JSON.parse(Buffer.from((await sandbox.request("/api/stock")).body, "base64").toString()).items.sort((a: { sku: string }, b: { sku: string }) => a.sku.localeCompare(b.sku));
    assert.deepEqual(await readApi(), [{ sku: "probe", quantity: 7 }, { sku: quoted, quantity: 4 }]);
    const competing = await Promise.all([post("/api/withdraw", { sku: "probe", quantity: 5 }), post("/api/withdraw", { sku: "probe", quantity: 5 })]);
    assert.deepEqual(competing.map(r => r.status).sort(), [200, 409]);
    const expected = [{ sku: "probe", quantity: 2 }, { sku: quoted, quantity: 4 }];
    assert.deepEqual(await readApi(), expected);
    // Trusted read-only SQL in the owned sandbox, independent of generated API.
    const probe = "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/tmp/inventory.sqlite',{readOnly:true});console.log(JSON.stringify(db.prepare('SELECT sku,quantity FROM stock ORDER BY sku').all()));db.close()";
    const actual = await promisify(execFile)("docker", ["exec", containerId, "node", "-e", probe], { timeout: 15000, windowsHide: true });
    rows = JSON.parse(actual.stdout);
    assert.deepEqual(rows, expected);
  } finally { await sandbox.close(); }
  await assert.rejects(promisify(execFile)("docker", ["inspect", containerId]));
  await assert.rejects(promisify(execFile)("docker", ["image", "inspect", derivedImage]));
  return { pass: true, rows, overdrawRejected: true, duplicateRejected: true, invalidInputRejected: true, quotedSku: true, competingWithdrawals: true, cleanup: true, scope: "SQLite file inside one ephemeral sandbox; no cross-container durability claim" };
}
