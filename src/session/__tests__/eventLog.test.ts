import { test } from "node:test";
import assert from "node:assert";
import { EventLog, foldProjections } from "../eventLog.js";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../../config.js";

test("append and read back", async () => {
  const taskId = "test-task-1";
  const el = new EventLog(taskId);
  await el.init(taskId, process.cwd());
  await el.append("test_event", { foo: "bar" });
  
  const content = await fs.readFile(path.join(DATA_DIR, "sessions", taskId, "events.jsonl"), "utf8");
  assert.ok(content.includes("test_event"));
  
  // Cleanup
  await fs.rm(path.join(DATA_DIR, "sessions", taskId), { recursive: true, force: true });
});
