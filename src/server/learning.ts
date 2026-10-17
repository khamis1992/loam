import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";

function learningFile(): string {
  return path.join(DATA_DIR, "learning.log");
}

export function readLearning(limit: number): unknown[] {
  try {
    const file = learningFile();
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
    return lines
      .slice(-limit)
      .reverse()
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { raw: l };
        }
      });
  } catch {
    return [];
  }
}

export function appendLearning(entry: unknown): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(learningFile(), `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    /* ignore audit-log errors */
  }
}
