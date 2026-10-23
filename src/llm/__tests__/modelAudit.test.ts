import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  editModelCounts,
  isEditTool,
  readEditModelLog,
  recordEditModel,
  recentEditModels,
  resetEditModelMemory,
} from "../modelAudit.js";

let tmpDir = "";
let logFile = "";

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-model-audit-"));
  logFile = path.join(tmpDir, "model-edits.jsonl");
});

after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("model edit audit", () => {
  it("recognizes edit tools only", () => {
    assert.equal(isEditTool("file_edit"), true);
    assert.equal(isEditTool("file_write"), true);
    assert.equal(isEditTool("code_session"), true);
    assert.equal(isEditTool("file_read"), false);
    assert.equal(isEditTool("shell_run"), false);
  });

  it("records only edits and attributes them to the model", () => {
    resetEditModelMemory();
    const ignored = recordEditModel({ step: 1, model: "m", tool: "file_read", path: "a.ts", ok: true, file: logFile });
    assert.equal(ignored, null);

    recordEditModel({ taskId: "t1", step: 2, model: "longcat", tool: "file_edit", path: "src/a.ts", ok: true, file: logFile });
    recordEditModel({ taskId: "t1", step: 3, model: "freellmapi", tool: "file_write", path: "src/b.ts", ok: false, file: logFile });

    assert.deepEqual(editModelCounts(), { longcat: 1, freellmapi: 1 });
    assert.equal(recentEditModels().length, 2);
    assert.equal(recentEditModels()[0]!.tool, "file_edit");
    assert.equal(recentEditModels()[1]!.ok, false);
  });

  it("persists records as JSONL and reads them back", () => {
    resetEditModelMemory();
    fs.rmSync(logFile, { force: true });
    recordEditModel({ step: 1, model: "m1", tool: "file_edit", path: "x.ts", ok: true, file: logFile });
    const onDisk = readEditModelLog(logFile);
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0]!.model, "m1");
    assert.equal(onDisk[0]!.path, "x.ts");
  });

  it("never stores argument payloads or secrets", () => {
    resetEditModelMemory();
    recordEditModel({ step: 1, model: "m1", tool: "file_edit", path: "x.ts", ok: true, file: logFile });
    const raw = fs.readFileSync(logFile, "utf8");
    assert.ok(!raw.includes("content"));
    assert.ok(raw.includes('"model":"m1"'));
  });
});
