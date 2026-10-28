import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { registerOfficeConnector, syncConnectorToSheet, syncOfficeConnector, testOfficeConnector } from "../connectors.js";
import { setSecret, deleteSecret } from "../../../server/secretsVault.js";
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

  it("webdav: PROPFIND probe, 404 mapping, and CSV/JSON sync into the row model", async () => {
    const csv = "\uFEFFالصنف;المبلغ\n\"إيرادات, رئيسية\";1200\nمصروف;40.5\n";
    const basic = "Basic " + Buffer.from("user:pass").toString("base64");
    const server = http.createServer((req, res) => {
      if (req.url === "/missing.csv") { res.writeHead(404); res.end("gone"); return; }
      if (req.method === "PROPFIND") {
        res.writeHead(207, { "content-type": "application/xml" });
        res.end("<D:multistatus><D:response><D:propstat><D:prop><D:getcontenttype>text/csv</D:getcontenttype><D:getlastmodified>Mon, 26 Oct 2026 00:00:00 GMT</D:getlastmodified></D:prop></D:propstat></D:response></D:multistatus>");
        return;
      }
      if (req.url === "/data.json") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify([{ metric: "Revenue", amount: 7 }])); return; }
      if (req.headers.authorization !== basic) { res.writeHead(401); res.end("auth"); return; }
      res.writeHead(200, { "content-type": "text/csv" });
      res.end(csv);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("address unavailable");
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal(setSecret("office", "TESTPASS", "pass"), true);
    try {
      const probeConnector = registerOfficeConnector({ scope: { tenantId: "local" }, name: "DAV probe", type: "webdav", config: { baseUrl: base, remotePath: "/report.csv", format: "csv" } });
      const probe = await testOfficeConnector(probeConnector.id, { workspace });
      assert.equal(probe.columns[0], "status");
      assert.equal(probe.rows[0]?.[0], "207");
      assert.equal(probe.rows[0]?.[1], "text/csv");
      assert.match(String(probe.rows[0]?.[2]), /GMT/);
      const missing = registerOfficeConnector({ scope: { tenantId: "local" }, name: "DAV missing", type: "webdav", config: { baseUrl: base, remotePath: "/missing.csv", format: "csv" } });
      await assert.rejects(testOfficeConnector(missing.id, { workspace }), /غير موجود/);
      const csvConnector = registerOfficeConnector({ scope: { tenantId: "local" }, name: "DAV csv", type: "webdav", config: { baseUrl: base, remotePath: "/report.csv", format: "csv", username: "user", passwordSecretName: "TESTPASS" } });
      const csvRows = await syncOfficeConnector(csvConnector.id, { workspace });
      assert.deepEqual(csvRows.columns, ["الصنف", "المبلغ"]);
      assert.equal(csvRows.rows[0]?.[0], "إيرادات, رئيسية");
      assert.equal(csvRows.rows[0]?.[1], 1200);
      assert.equal(csvRows.rows[1]?.[1], 40.5);
      const jsonConnector = registerOfficeConnector({ scope: { tenantId: "local" }, name: "DAV json", type: "webdav", config: { baseUrl: base, remotePath: "/data.json", format: "json" } });
      const jsonRows = await syncOfficeConnector(jsonConnector.id, { workspace });
      assert.deepEqual(jsonRows.rows[0], ["Revenue", 7]);
      const artifact = await syncConnectorToSheet(csvConnector.id, { workspace, taskId, path: "dav.xlsx" });
      assert.equal(artifact.kind, "spreadsheet");
      const sheet = await readSheetDoc(path.join(workspace, "dav.xlsx"), { taskId, path: "dav.xlsx", name: "dav.xlsx" });
      assert.equal(sheet.sheets[0]?.cells[0]?.[0], "الصنف");
    } finally {
      deleteSecret("office", "TESTPASS");
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("webdav: requires HTTPS outside loopback and a full config", () => {
    assert.throws(() => registerOfficeConnector({ scope: { tenantId: "local" }, name: "DAV bad", type: "webdav", config: { baseUrl: "https://example.com/dav" } }), /baseUrl, remotePath/);
    assert.throws(() => registerOfficeConnector({ scope: { tenantId: "local" }, name: "DAV http", type: "webdav", config: { baseUrl: "http://dav.example.com", remotePath: "/x.csv", format: "csv" } }), /HTTPS/);
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
