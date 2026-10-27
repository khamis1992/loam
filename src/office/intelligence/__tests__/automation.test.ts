import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { registerOfficeConnector, syncConnectorToSheet, syncOfficeConnector } from "../connectors.js";
import { registerOfficeWorkflow, runOfficeWorkflow } from "../workflows.js";
import { createClientPortalShare, readClientPortal, revokeClientPortalShare } from "../legal/portal.js";
import { createMatter } from "../legal/matters.js";
import { readSheetDoc } from "../../../server/workspace/sheetIO.js";
import type { OfficeModelGateway } from "../modelGateway.js";

let tmp = "";
let workspace = "";
let closeDb: () => void;
let taskId = "";

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-office-automation-"));
  workspace = path.join(tmp, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  process.env.MANUS_LOCAL_DATA_DIR = path.join(tmp, "data");
  const sqlite = await import("../../../server/sqliteStore.js");
  closeDb = sqlite.closeDb;
  const db = await import("../../../server/db.js");
  taskId = db.createTask("Office workflow").id;
  db.setTaskWorkspace(taskId, workspace);
  const source = new DatabaseSync(path.join(workspace, "source.db"));
  source.exec("CREATE TABLE finance(metric TEXT, amount INTEGER); INSERT INTO finance VALUES ('Revenue', 100), ('Cost', 40);");
  source.close();
});

after(() => {
  closeDb();
  delete process.env.MANUS_LOCAL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("Office connectors and workflows", () => {
  it("syncs read-only SQLite data into a real workbook and runs a monthly workflow", async () => {
    const connector = registerOfficeConnector({ scope: { tenantId: "local" }, name: "Finance", type: "sqlite", config: { databasePath: "source.db", query: "SELECT metric, amount FROM finance ORDER BY metric" } });
    const rows = await syncOfficeConnector(connector.id, { workspace });
    assert.deepEqual(rows.columns, ["metric", "amount"]);
    assert.equal(rows.rowCount, 2);
    const artifact = await syncConnectorToSheet(connector.id, { workspace, taskId, path: "finance.xlsx" });
    const doc = await readSheetDoc(path.join(workspace, "finance.xlsx"), { taskId, path: "finance.xlsx", name: "finance.xlsx" });
    assert.equal(doc.sheets[0]?.cells[1]?.[0], "Cost");
    assert.equal(artifact.kind, "spreadsheet");
    const workflow = registerOfficeWorkflow({ scope: { tenantId: "local" }, name: "Monthly", type: "monthly-report", connectorId: connector.id, targetTaskId: taskId, outputPath: "monthly.xlsx", schedule: { cron: "0 8 1 * *", timezone: "Asia/Qatar" } });
    assert.ok(workflow.scheduleId);
    const result = await runOfficeWorkflow(workflow.id, { baseWorkspace: workspace, model: {} as OfficeModelGateway });
    assert.equal(result.artifact?.path, "monthly.xlsx");
    assert.equal(result.run?.capability, "sheet-analysis");
    assert.throws(() => registerOfficeConnector({ scope: { tenantId: "local" }, name: "Unsafe", type: "sqlite", config: { databasePath: "source.db", query: "DELETE FROM finance" } }), /read-only/);
  });

  it("reads REST JSON arrays through a bounded local connector", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ metric: "Revenue", amount: 100 }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("address unavailable");
      const connector = registerOfficeConnector({ scope: { tenantId: "local" }, name: "REST", type: "rest-json", config: { url: `http://127.0.0.1:${address.port}/data`, dataPath: "data" } });
      const result = await syncOfficeConnector(connector.id, { workspace });
      assert.equal(result.rows[0]?.[0], "Revenue");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe("client portal confidentiality", () => {
  it("exposes only the approved matter view and revokes access", () => {
    const matter = createMatter({ tenantId: "local", title: "قضية", client: "عميل", practiceArea: "commercial", summary: "موجز معتمد", parties: [{ name: "طرف داخلي", role: "internal" }], tasks: [{ title: "مهمة داخلية" }] });
    const share = createClientPortalShare(matter.id);
    const portal = readClientPortal(share.token);
    assert.equal(portal.title, "قضية");
    assert.equal("parties" in portal, false);
    assert.equal("tasks" in portal, false);
    revokeClientPortalShare(share.token);
    assert.throws(() => readClientPortal(share.token), /expired or revoked/);
  });
});
