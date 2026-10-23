// Adapted from jcode (MIT) ref/bench_memory_cli.py (process-tree PSS summing)
//
// Samples the working set / RSS of a process tree. On Windows the whole table is
// read with a streaming PowerShell pipeline (no `wmic`, which is gone on newer
// builds, and no interactive prompt); on Linux the PSS comes from
// /proc/<pid>/smaps_rollup so shared pages are not double counted.
//
// Each sample takes one fresh snapshot, so a tree that grows or shrinks between
// samples is reflected (the cached/pid-list-only variants of this reader exist
// for tests via `pidsFor` / `memoryFor`).
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SampleOptions {
  /** Milliseconds between samples. Defaults to 200. */
  intervalMs?: number;
  /** How long to sample before giving up. Defaults to 5000. */
  timeoutMs?: number;
  /** Override the pid reader (tests). */
  pidsFor?: (roots: number[]) => Promise<number[]>;
  /** Override the memory reader (tests). */
  memoryFor?: (pid: number) => Promise<number | null>;
  /** Called after each sample. */
  onSample?: (sample: MemorySample) => void;
  /**
   * Optional stop signal. When its promise settles the sampler stops early and
   * returns the samples taken so far, so a caller can keep sampling until its
   * work actually finishes instead of sampling for a fixed window.
   */
  stop?: Promise<unknown>;
}

export interface MemorySample {
  /** Epoch milliseconds of the sample. */
  at: number;
  /** Total MB for the tree at this instant. */
  totalMB: number;
  /** Number of processes that reported memory. */
  processCount: number;
}

export interface MemoryReport {
  /** Baseline sample taken before the benchmark work starts. */
  idleMB: number;
  /** Highest sample observed. */
  peakMB: number;
  /** Last sample observed. */
  finalMB: number;
  /** Number of processes counted at the peak. */
  peakProcessCount: number;
  samples: MemorySample[];
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** Resident bytes reported by the OS. */
  memoryBytes: number;
}

export interface ProcessTreeReader {
  /** Snapshot of live processes (pid, parent, resident bytes). */
  listProcesses(): Promise<ProcessInfo[]>;
  /** Resident MB for a single pid, or null when unavailable. */
  readMemoryMB(pid: number): Promise<number | null>;
}

const win32 = process.platform === "win32";

/**
 * Backstop delay when a `stop` promise is supplied: if that promise never
 * settles the sampler must still eventually return instead of waiting forever.
 * Long enough that a real stop signal always wins.
 */
const MAX_SAFE_DELAY_MS = 10 * 60_000;

/** Strip the quoting CSV writers add around every field. */
function unquote(value: string): string {
  return value.trim().replace(/^"|"$/g, "");
}

/** Parse a `pid,ppid,bytes` row (optionally quoted) into numbers, or null. */
export function parsePidRow(parts: string[]): ProcessInfo | null {
  if (parts.length < 3) return null;
  const pid = Number(unquote(parts[0]!));
  const ppid = Number(unquote(parts[1]!));
  const memoryBytes = Number(unquote(parts[2]!));
  if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(memoryBytes)) return null;
  return { pid, ppid, memoryBytes };
}

/** Rows of `pid,ppid,bytes`, one process per line, no header. */
export function parseProcessRows(stdout: string): ProcessInfo[] {
  const rows: ProcessInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed = parsePidRow(trimmed.split(","));
    if (parsed) rows.push(parsed);
  }
  return rows;
}

/** `pid,ppid,bytes` for the whole system, from a streaming PowerShell pipeline. */
export function windowsProcessScript(): string {
  return "Get-CimInstance Win32_Process | %{ '{0},{1},{2}' -f $_.ProcessId,$_.ParentProcessId,$_.WorkingSetSize }";
}

/** All pids in the trees rooted at `roots`, from one snapshot. */
export function pidsFromRows(rows: ProcessInfo[], roots: number[]): number[] {
  const children = new Map<number, number[]>();
  const known = new Set<number>();
  for (const row of rows) {
    known.add(row.pid);
    const list = children.get(row.ppid) ?? [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const seen = new Set<number>();
  const stack = [...roots];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  return [...seen].filter((pid) => known.has(pid));
}

/** Sum the resident bytes of the given pids from one snapshot. */
export function sumTreeBytes(rows: ProcessInfo[], pids: number[]): { totalMB: number; processCount: number } {
  const wanted = new Set(pids);
  let totalBytes = 0;
  let counted = 0;
  for (const row of rows) {
    if (!wanted.has(row.pid)) continue;
    totalBytes += row.memoryBytes;
    counted += 1;
  }
  return { totalMB: round1(totalBytes / (1024 * 1024)), processCount: counted };
}

/**
 * Windows reader. One streaming PowerShell command builds the whole table with
 * `|%{...}` so no CSV conversion happens on the PowerShell side; the process
 * runs with `-NonInteractive` (never a prompt). `wmic` is gone on newer builds,
 * so it is not used.
 */
class WindowsProcessTreeReader implements ProcessTreeReader {
  async listProcesses(): Promise<ProcessInfo[]> {
    try {
      const { stdout } = await execFileAsync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", windowsProcessScript()],
        { windowsHide: true, timeout: 20_000, maxBuffer: 32 * 1024 * 1024 },
      );
      return parseProcessRows(stdout);
    } catch {
      return [];
    }
  }

  async readMemoryMB(pid: number): Promise<number | null> {
    const rows = await this.listProcesses();
    for (const row of rows) {
      if (row.pid === pid) return row.memoryBytes / (1024 * 1024);
    }
    return null;
  }
}

/** Linux reader: /proc/<pid>/stat for the tree, smaps_rollup for PSS. */
class ProcProcessTreeReader implements ProcessTreeReader {
  async listProcesses(): Promise<ProcessInfo[]> {
    const stat = readProcStat();
    const rows: ProcessInfo[] = [];
    for (const pid of stat.keys()) {
      const pss = readPssBytes(pid);
      if (pss === null) continue;
      rows.push({ pid, ppid: stat.get(pid)!.ppid, memoryBytes: pss });
    }
    return rows;
  }

  async readMemoryMB(pid: number): Promise<number | null> {
    const pss = readPssBytes(pid);
    return pss === null ? null : pss / (1024 * 1024);
  }
}

function readProcStat(): Map<number, { ppid: number; pgrp: number }> {
  const out = new Map<number, { ppid: number; pgrp: number }>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync("/proc", { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      const stat = fs.readFileSync(path.join("/proc", entry.name, "stat"), "utf8");
      const close = stat.lastIndexOf(")");
      if (close < 0) continue;
      const rest = stat.slice(close + 2).split(/\s+/);
      const ppid = Number(rest[1]);
      const pgrp = Number(rest[2]);
      if (Number.isFinite(ppid) && Number.isFinite(pgrp)) out.set(pid, { ppid, pgrp });
    } catch {
      /* process exited */
    }
  }
  return out;
}

function readPssBytes(pid: number): number | null {
  try {
    const text = fs.readFileSync(path.join("/proc", String(pid), "smaps_rollup"), "utf8");
    for (const line of text.split("\n")) {
      if (line.startsWith("Pss:")) return Number(line.split(/\s+/)[1]) * 1024;
    }
    return null;
  } catch {
    return null;
  }
}

export function defaultProcessTreeReader(): ProcessTreeReader {
  return win32 ? new WindowsProcessTreeReader() : new ProcProcessTreeReader();
}

/** All pids in the trees rooted at `roots` (including the roots). */
export async function collectTreePids(reader: ProcessTreeReader, roots: number[]): Promise<number[]> {
  const rows = await reader.listProcesses();
  return pidsFromRows(rows, roots);
}

/**
 * Sample the memory of a process tree until `timeoutMs` elapses. Returns
 * idle/peak/final MB and every sample. Unless `pidsFor`/`memoryFor` are given,
 * each sample costs one snapshot and measures every pid of the tree at once.
 */
export async function sampleProcessTree(rootPids: number[], options: SampleOptions = {}): Promise<MemoryReport> {
  const intervalMs = Math.max(1, options.intervalMs ?? 200);
  const timeoutMs = Math.max(0, options.timeoutMs ?? 5000);
  const reader = defaultProcessTreeReader();
  const useFastPath = options.pidsFor === undefined && options.memoryFor === undefined;
  const pidsFor = options.pidsFor ?? ((roots: number[]) => collectTreePids(reader, roots));
  const memoryFor = options.memoryFor ?? ((pid: number) => reader.readMemoryMB(pid));
  const samples: MemorySample[] = [];
  const deadline = Date.now() + timeoutMs;

  const takeSample = async (): Promise<MemorySample> => {
    if (useFastPath) {
      const rows = await reader.listProcesses();
      const pids = pidsFromRows(rows, rootPids);
      const { totalMB, processCount } = sumTreeBytes(rows, pids);
      return { at: Date.now(), totalMB, processCount };
    }
    const pids = await pidsFor(rootPids);
    let total = 0;
    let counted = 0;
    for (const pid of pids) {
      const mb = await memoryFor(pid);
      if (mb === null) continue;
      total += mb;
      counted += 1;
    }
    return { at: Date.now(), totalMB: round1(total), processCount: counted };
  };

  const idle = await takeSample();
  samples.push(idle);
  options.onSample?.(idle);

  // The stop signal is always observed so a caller can stop sampling as soon as
  // its work finishes, even when that happens before the timeout window ends.
  let stopped = false;
  if (options.stop) {
    void Promise.race([options.stop.then(() => true), delay(MAX_SAFE_DELAY_MS).then(() => false)]).then(
      (didStop) => {
        stopped = didStop;
      },
    );
  }

  while (!stopped && Date.now() < deadline) {
    await delay(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
    const sample = await takeSample();
    samples.push(sample);
    options.onSample?.(sample);
  }

  let peak = samples[0]!;
  for (const sample of samples) {
    if (sample.totalMB > peak.totalMB) peak = sample;
  }
  const final = samples[samples.length - 1]!;
  return {
    idleMB: idle.totalMB,
    peakMB: peak.totalMB,
    finalMB: final.totalMB,
    peakProcessCount: peak.processCount,
    samples,
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
