/**
 * workspace/sheet editor IO + routes: xlsx JSON round-trip and HTTP status paths.
 *
 * Like the other server tests, the data directory env var is set before any
 * runtime import because config.ts reads it at module load.
 */
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { before, after, describe, it } from "node:test";

interface SheetDoc {
  taskId: string;
  path: string;
  name: string;
  sheets: Array<{
    name: string;
    cells: string[][];
    styles: Record<string, Record<string, string | number | boolean>>;
    columnWidths: number[];
    merges: string[];
  }>;
  notes: string[];
}

interface SheetIOApi {
  readSheetDoc: (abs: string, identity: { taskId: string; path: string; name: string }) => Promise<SheetDoc>;
  writeSheetDoc: (abs: string, doc: SheetDoc) => Promise<{ bytes: number; warnings: string[] }>;
  parseSheetDoc: (input: unknown, identity: { taskId: string; path: string; name: string }) => SheetDoc;
}

interface DbApi {
  createTask: (prompt: string) => { id: string };
  setTaskWorkspace: (id: string, workspace: string) => void;
}

type RoutesApi = (req: http.IncomingMessage, res: http.ServerResponse, p: string) => Promise<boolean>;

interface RecordedResponse {
  status: number;
  body: string;
  onWriteHead: (status: number) => void;
  onEnd: (chunk?: unknown) => void;
}

let tmpDir = "";
let workspaceDir = "";
let closeDb: () => void;
let io: SheetIOApi;
let dbApi: DbApi;
let routes: RoutesApi;
let taskId = "";

function fakeRes(): { res: unknown; captured: RecordedResponse } {
  const captured: RecordedResponse = { status: 0, body: "", onWriteHead: () => {}, onEnd: () => {} };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      captured.onWriteHead(status);
      return res;
    },
    end(chunk?: unknown) {
      if (typeof chunk === "string") captured.body += chunk;
      captured.onEnd(chunk);
      return res;
    },
  };
  return { res, captured };
}

function fakeReq(method: string, url: string): http.IncomingMessage {
  const stream = new PassThrough();
  Object.assign(stream, { method, url, headers: { host: "127.0.0.1" } });
  return stream as unknown as http.IncomingMessage;
}

async function callRoutes(req: http.IncomingMessage, feedBody?: string): Promise<RecordedResponse> {
  const { res, captured } = fakeRes();
  const pending = routes(req, res as unknown as http.ServerResponse, "/api/workspace/sheet/file");
  if (feedBody !== undefined) {
    req.write(feedBody);
  }
  req.end();
  await pending;
  return captured;
}

function sampleDoc(pathRel: string): SheetDoc {
  return {
    taskId,
    path: pathRel,
    name: path.basename(pathRel),
    sheets: [
      {
        name: "Budget",
        cells: [
          ["Item", "Cost", "Total"],
          ["office", "100", "=B2+B3"],
          ["coffee", "5", ""],
        ],
        styles: { A1: { bold: true, fontFamily: "Calibri", fontSize: 12 }, C2: { numberFormat: "0.00" } },
        columnWidths: [14, 9, 8],
        rowHeights: [20, 20, 20],
        merges: [],
        hiddenRows: [false, false, false],
        hiddenColumns: [false, false, false],
      },
      {
        name: "Notes",
        cells: [["Noah notes"], []],
        styles: { A1: { bold: true } },
        columnWidths: [18],
        rowHeights: [20, 20],
        merges: [],
        hiddenRows: [false, false],
        hiddenColumns: [false],
      },
    ],
    notes: [],
  } as unknown as SheetDoc;
}

describe("workspace sheet IO", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-sheetws-"));
    workspaceDir = path.join(tmpDir, "tasks");
    fs.mkdirSync(workspaceDir, { recursive: true });
    process.env.MANUS_LOCAL_DATA_DIR = path.join(tmpDir, "data");
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    io = (await import("../workspace/sheetIO.js")) as unknown as SheetIOApi;
    dbApi = (await import("../db.js")) as unknown as DbApi;
    routes = (await import("../routes/workspaceSheet.js")).handleWorkspaceSheetRoutes as unknown as RoutesApi;
    const task = dbApi.createTask("sheet workspace test");
    taskId = task.id;
    dbApi.setTaskWorkspace(taskId, workspaceDir);
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("round-trips values, formulas, merges and styles through xlsx", async () => {
    const abs = path.join(workspaceDir, "budget.xlsx");
    const written = await io.writeSheetDoc(abs, sampleDoc("budget.xlsx"));
    assert.ok(written.bytes > 0);
    assert.ok(fs.existsSync(abs));
    const doc = await io.readSheetDoc(abs, { taskId, path: "budget.xlsx", name: "budget.xlsx" });
    assert.ok(Array.isArray(doc.notes));
    const budget = doc.sheets[0]!;
    assert.equal(budget.name, "Budget");
    assert.deepEqual(budget.cells[0], ["Item", "Cost", "Total"]);
    assert.equal(budget.cells[1]![0], "office");
    assert.equal(budget.cells[2]![0], "coffee");
    // Numbers are round-tripped as numeric text, formulas keep the leading '='.
    assert.equal(budget.cells[1]![1], "100");
    assert.ok(budget.cells[3]?.[0] === undefined); // trailing empty cells are not materialized
    assert.equal(budget.styles.A1?.bold, true);
    assert.equal(budget.styles.A1?.fontFamily, "Calibri");
    assert.ok(typeof budget.styles.A1?.fontSize === "number");
  });

  it("separates merged ranges and keeps workbook sheets in order", async () => {
    const abs = path.join(workspaceDir, "merged.xlsx");
    const doc: SheetDoc = sampleDoc("merged.xlsx");
    doc.sheets[0]!.merges = ["A4:B4"];
    doc.sheets[0]!.cells = [...doc.sheets[0]!.cells, ["header2", "", ""]];
    doc.sheets[0]!.rowHeights = [...doc.sheets[0]!.rowHeights, 20];
    doc.sheets[0]!.hiddenRows = [...doc.sheets[0]!.hiddenRows, false];
    const second = doc.sheets[1]!;
    second.cells = [["go last"]];
    await io.writeSheetDoc(abs, doc);
    const read = await io.readSheetDoc(abs, { taskId, path: "merged.xlsx", name: "merged.xlsx" });
    assert.equal(read.sheets[0]!.name, "Budget");
    assert.equal(read.sheets[1]!.name, "Notes");
    assert.ok(read.sheets[0]!.merges.includes("A4:B4"));
    // merged tail cells collapse to empty text on read
    assert.equal(read.sheets[0]!.cells[3]![1], "");
  });

  it("rejects invalid documents with clear errors", () => {
    assert.throws(() => (io.parseSheetDoc({ sheets: [] }, { taskId, path: "x.xlsx", name: "x.xlsx" })), /at least one sheet/);
    const doc = io.parseSheetDoc({ sheets: [{ name: "A", cells: [["1", "2", "3"]], merges: ["ZZ:9"] }] }, { taskId, path: "x.xlsx", name: "x.xlsx" });
    assert.equal(doc.sheets[0]!.cells.length, 1);
    assert.equal(doc.sheets[0]!.merges.length, 0);
    assert.ok(doc.notes.some((n) => n.toLowerCase().includes("merged")));
  });

  it("routes: PUT saves the JSON document back as xlsx", async () => {
    const req = fakeReq("PUT", `/api/workspace/sheet/file?taskId=${encodeURIComponent(taskId)}&path=put.xlsx`);
    const captured = await callRoutes(req, JSON.stringify(sampleDoc("put.xlsx")));
    assert.equal(captured.status, 200);
    const body = JSON.parse(captured.body) as { ok?: boolean; bytes?: number };
    assert.equal(body.ok, true);
    assert.ok((body.bytes ?? 0) > 0);
    const doc = await io.readSheetDoc(path.join(workspaceDir, "put.xlsx"), { taskId, path: "put.xlsx", name: "put.xlsx" });
    assert.equal(doc.sheets[0]!.cells[1]![0], "office");
  });

  it("routes: GET returns the JSON model", async () => {
    const req = fakeReq("GET", `/api/workspace/sheet/file?taskId=${encodeURIComponent(taskId)}&path=put.xlsx`);
    const captured = await callRoutes(req);
    assert.equal(captured.status, 200);
    const doc = JSON.parse(captured.body) as SheetDoc;
    assert.equal(doc.name, "put.xlsx");
    assert.equal(doc.sheets.length, 2);
  });

  it("routes: rejects missing task, bad extension and bad JSON", async () => {
    const missingTask = fakeReq("GET", "/api/workspace/sheet/file?taskId=task_missing&path=a.xlsx");
    assert.equal((await callRoutes(missingTask)).status, 404);

    const badExt = fakeReq("GET", `/api/workspace/sheet/file?taskId=${encodeURIComponent(taskId)}&path=notes.txt`);
    assert.equal((await callRoutes(badExt)).status, 400);

    const badJson = fakeReq("PUT", `/api/workspace/sheet/file?taskId=${encodeURIComponent(taskId)}&path=x.xlsx`);
    assert.equal((await callRoutes(badJson, "{ broken")).status, 400);

    const notFound = fakeReq("GET", `/api/workspace/sheet/file?taskId=${encodeURIComponent(taskId)}&path=absent.xlsx`);
    assert.equal((await callRoutes(notFound)).status, 404);
  });

  it("routes: rejects unknown methods for the endpoint", async () => {
    const req = fakeReq("DELETE", `/api/workspace/sheet/file?taskId=${encodeURIComponent(taskId)}&path=put.xlsx`);
    const captured = await callRoutes(req);
    assert.equal(captured.status, 405);
  });
});
