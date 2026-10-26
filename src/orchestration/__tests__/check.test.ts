import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The secret-scan probe writes one row; it must land in a scratch database,
// never the developer's manus.db.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-orch-check-"));
process.env.LOAM_DATA_DIR = tmp;
process.env.MANUS_LOCAL_DATA_DIR = tmp;
const { checkOrchestration } = await import("../../scripts/check-orchestration.js");
const { database } = await import("../../server/sqliteStore.js");
const { TRACE_SCHEMA_SQL } = await import("../tracing/tracer.js");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("check:orchestration passes on the reference tree and catches a stored secret", () => {
  assert.deepEqual(checkOrchestration(root), []);
  database().exec(TRACE_SCHEMA_SQL);
  database()
    .prepare("INSERT INTO trace_spans (trace_id, span_id, name, kind, start_ms, attributes) VALUES (?, ?, 'x', 'internal', 1, ?)")
    .run("a".repeat(32), "b".repeat(16), JSON.stringify({ leaked: "sk-abcdefghijklmnopqrstuvwxyz" }));
  assert.deepEqual(checkOrchestration(root), ["secret-shaped value stored in trace_spans.attributes"]);
});
