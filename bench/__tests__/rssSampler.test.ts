/**
 * Tests for bench/rssSampler.ts (J2 process-tree memory sampler).
 *
 * Guarantees under test:
 *  - a child node process reports more than 0 MB
 *  - peak >= final >= idle ordering and sample bookkeeping
 *  - injected readers are used (no OS calls needed)
 *  - a dead/absent root reports 0 instead of throwing
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";

import {
  collectTreePids,
  parsePidRow,
  parseProcessRows,
  pidsFromRows,
  sampleProcessTree,
  sumTreeBytes,
  windowsProcessScript,
  type ProcessInfo,
  type ProcessTreeReader,
} from "../rssSampler.js";

class StubReader implements ProcessTreeReader {
  constructor(private readonly rows: Array<{ pid: number; ppid: number; memoryBytes: number }>) {}
  async listProcesses(): Promise<Array<{ pid: number; ppid: number; memoryBytes: number }>> {
    return this.rows;
  }
  async readMemoryMB(pid: number): Promise<number | null> {
    const row = this.rows.find((r) => r.pid === pid);
    return row ? row.memoryBytes / (1024 * 1024) : null;
  }
}

describe("bench/rssSampler", () => {
  it("collects the whole tree including the root", async () => {
    const reader = new StubReader([
      { pid: 1, ppid: 0, memoryBytes: 10 * 1024 * 1024 },
      { pid: 2, ppid: 1, memoryBytes: 20 * 1024 * 1024 },
      { pid: 3, ppid: 2, memoryBytes: 30 * 1024 * 1024 },
      { pid: 99, ppid: 98, memoryBytes: 99 * 1024 * 1024 },
    ]);
    const pids = await collectTreePids(reader, [1]);
    assert.deepEqual(pids.sort((a, b) => a - b), [1, 2, 3]);
  });

  it("returns idle/peak/final from injected readers", async () => {
    const reader = new StubReader([
      { pid: 100, ppid: 0, memoryBytes: 50 * 1024 * 1024 },
      { pid: 101, ppid: 100, memoryBytes: 25 * 1024 * 1024 },
    ]);
    let calls = 0;
    const report = await sampleProcessTree([100], {
      timeoutMs: 30,
      intervalMs: 10,
      pidsFor: (roots) => collectTreePids(reader, roots),
      memoryFor: async (pid) => {
        calls += 1;
        return reader.readMemoryMB(pid);
      },
    });
    assert.equal(report.idleMB, 75);
    assert.equal(report.peakMB, 75);
    assert.equal(report.finalMB, 75);
    assert.ok(calls >= 2, "memory was read at least twice");
    assert.ok(report.samples.length >= 2);
  });

  it("parses unquoted and CSV-quoted pid rows and walks the tree from one snapshot", () => {
    assert.equal(parsePidRow(["1", "0", "8192"])!.pid, 1);
    const quoted = parsePidRow(['"2"', '"1"', '"1048576"']);
    assert.deepEqual(quoted, { pid: 2, ppid: 1, memoryBytes: 1048576 });
    assert.equal(parsePidRow(['"x"', "1", "1"]), null);
    assert.equal(parsePidRow(["1", "0"]), null);

    const rows = parseProcessRows("2,1,1048576\r\n1,0,8192\n") as ProcessInfo[];
    assert.deepEqual(rows, [
      { pid: 2, ppid: 1, memoryBytes: 1048576 },
      { pid: 1, ppid: 0, memoryBytes: 8192 },
    ]);
    assert.deepEqual(pidsFromRows(rows, [1]), [1, 2]);
    assert.deepEqual(pidsFromRows(rows, [99]), []);
    assert.equal(sumTreeBytes(rows, [1, 2]).totalMB, 1);
    assert.equal(sumTreeBytes(rows, [1, 2]).processCount, 2);
  });

  it("samples a real child node process at more than 0 MB with one snapshot per sample", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 60000); globalThis.buf = Buffer.alloc(24 * 1024 * 1024, 1);"],
      { stdio: "ignore", windowsHide: true },
    );
    try {
      const report = await sampleProcessTree([child.pid!], { timeoutMs: 1500, intervalMs: 250 });
      assert.ok(report.peakMB > 0, `child should report > 0 MB, got ${report.peakMB}`);
      assert.ok(report.finalMB > 0, `child should still report > 0 MB, got ${report.finalMB}`);
      assert.ok(report.peakProcessCount >= 1, "at least the child is counted");
      assert.ok(report.samples.length >= 1, "at least one snapshot was taken");
    } finally {
      child.kill();
    }
  });

  it("does not throw when the root no longer exists", async () => {
    const report = await sampleProcessTree([999_999_999], {
      timeoutMs: 20,
      intervalMs: 10,
      pidsFor: async () => [],
      memoryFor: async () => null,
    });
    assert.equal(report.idleMB, 0);
    assert.equal(report.peakMB, 0);
    assert.equal(report.finalMB, 0);
    assert.equal(report.peakProcessCount, 0);
  });

  it("reports the peak when a tree grows between samples", async () => {
    let sizeMB = 10;
    const report = await sampleProcessTree([1], {
      timeoutMs: 60,
      intervalMs: 15,
      pidsFor: async () => [1],
      memoryFor: async () => {
        const value = sizeMB;
        sizeMB = 40;
        return value;
      },
    });
    assert.equal(report.idleMB, 10);
    assert.equal(report.peakMB, 40);
  });

  it("windowsProcessScript streams pid,ppid,bytes rows", () => {
    assert.match(windowsProcessScript(), /Win32_Process/);
    assert.match(windowsProcessScript(), /WorkingSetSize/);
    assert.ok(!windowsProcessScript().includes("ConvertTo-Csv"), "no CSV conversion on the PowerShell side");
  });
});
