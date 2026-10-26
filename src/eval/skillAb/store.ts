import fs from "node:fs";
import path from "node:path";
import type { AbResult } from "./stats.js";
import type { SkillAbRunConfig } from "./types.js";

export interface StoredAbRun {
  v: 1;
  runId: string;
  createdAt: string;
  config: Omit<SkillAbRunConfig, "tasks"> & { taskIds: string[] };
  result: AbResult;
}

export function saveAbRun(dir: string, run: StoredAbRun): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${run.runId}.json`);
  fs.writeFileSync(file, JSON.stringify(run, null, 2), "utf8");
  return file;
}

export function loadAbRun(file: string): StoredAbRun {
  return JSON.parse(fs.readFileSync(file, "utf8")) as StoredAbRun;
}
