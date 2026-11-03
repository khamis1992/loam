import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createRecallService, openRecallFile } from "../../memory/recall/service.js";
import { LEGAL_SCOPE } from "../../memory/recall/types.js";

describe("recall.mcp", () => {
  it("round-trips over stdio, refuses writes, and hides the legal scope", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-mcp-"));
    const db = path.join(dir, "recall.db");
    const service = createRecallService(openRecallFile(db));
    await service.remember({ content: "Khamis prefers Arabic reports", scope: "user", origin: "user", kind: "preference" });
    await service.remember({ content: "private legal note", scope: LEGAL_SCOPE, origin: "user", kind: "fact" });
    service.repo.db.close();
    const child = spawn(process.execPath, ["--import", "tsx", "src/mcp/recallServer.ts", "--db", db], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LOAM_RECALL_MCP_WRITE: "0" },
    });
    const lines: string[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim()) lines.push(line);
    });
    const send = (id: number, method: string, params: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    };
    send(1, "initialize", {});
    send(2, "tools/list", {});
    send(3, "tools/call", { name: "memory_recall", arguments: { query: "Arabic" } });
    send(4, "tools/call", { name: "memory_store", arguments: { content: "should not write" } });
    send(5, "tools/call", { name: "memory_recall", arguments: { query: "legal" } });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    child.kill();
    await new Promise((resolve) => child.once("close", resolve));
    const bodies = lines.map((line) => JSON.parse(line) as { id: number; result?: { content?: Array<{ text: string }>; tools?: unknown[] } });
    const recall = bodies.find((row) => row.id === 3);
    const store = bodies.find((row) => row.id === 4);
    const legal = bodies.find((row) => row.id === 5);
    assert.match(recall?.result?.content?.[0]?.text ?? "", /Arabic/);
    assert.match(store?.result?.content?.[0]?.text ?? "", /disabled/);
    assert.equal((legal?.result?.content?.[0]?.text ?? "").includes("private legal note"), false);
    assert.ok((bodies.find((row) => row.id === 2)?.result?.tools?.length ?? 0) >= 3);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the server process may still hold the db */ }
  });
});
