import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

const pexec = promisify(execFile);

/**
 * graph.json is compact JSON whose LAST key is `built_at_commit` (OBSERVED on
 * the box). Reading the final 4 KiB avoids parsing a ~19 MB file in Electron's
 * main process just to learn the commit.
 */
export function readBuiltAtCommit(graphPath: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(graphPath, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 4096);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const m = /"built_at_commit"\s*:\s*"([0-9a-f]{40})"/.exec(buf.toString("utf8"));
    return m?.[1] ?? null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** `{schema_version, graphify_version}` from the head of graph.json (first 512 bytes). */
export function readGraphMeta(graphPath: string): { schemaVersion?: number; graphifyVersion?: string } {
  let fd: number | undefined;
  try {
    fd = fs.openSync(graphPath, "r");
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, 512, 0);
    const head = buf.subarray(0, n).toString("utf8");
    const sv = /"schema_version"\s*:\s*(\d+)/.exec(head)?.[1];
    const gv = /"graphify_version"\s*:\s*"([^"]+)"/.exec(head)?.[1];
    return { schemaVersion: sv ? Number(sv) : undefined, graphifyVersion: gv };
  } catch {
    return {};
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** HEAD of the repo at `root`, or null outside git / git missing. */
export async function gitHead(root: string, gitBin = "git"): Promise<string | null> {
  try {
    const { stdout } = await pexec(gitBin, ["-C", root, "rev-parse", "HEAD"], { timeout: 5_000, windowsHide: true });
    const s = stdout.trim();
    return /^[0-9a-f]{40}$/.test(s) ? s : null;
  } catch {
    return null;
  }
}
