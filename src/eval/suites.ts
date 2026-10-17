import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, EVALS_DIR } from "../config.js";
import { log } from "../log.js";
import type { EvalCase, EvalSuite } from "./types.js";

export interface SuiteSource {
  id: string;
  name: string;
  cases: number;
  source: "builtin" | "draft";
  path: string;
}

export function draftsDir(): string {
  const dir = path.join(DATA_DIR, "evals", "drafts");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function parseSuiteFile(file: string): EvalSuite | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<EvalSuite>;
    if (!raw.id || !Array.isArray(raw.cases)) return null;
    const cases: EvalCase[] = raw.cases.filter(
      (c): c is EvalCase => Boolean(c && typeof c.id === "string" && typeof c.prompt === "string"),
    );
    if (cases.length === 0) return null;
    return { id: String(raw.id), name: String(raw.name ?? raw.id), version: Number(raw.version ?? 1), cases };
  } catch (err) {
    log.warn(`eval: failed to parse suite ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function listDir(dir: string, source: SuiteSource["source"]): SuiteSource[] {
  const out: SuiteSource[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".json"));
  } catch {
    return out;
  }
  for (const f of files) {
    const full = path.join(dir, f);
    const suite = parseSuiteFile(full);
    if (suite) out.push({ id: suite.id, name: suite.name, cases: suite.cases.length, source, path: full });
  }
  return out;
}

export function listSuites(): SuiteSource[] {
  return [...listDir(EVALS_DIR, "builtin"), ...listDir(draftsDir(), "draft")];
}

export function loadSuite(ref: string): EvalSuite {
  const looksLikePath = /[\\/]/.test(ref) || ref.toLowerCase().endsWith(".json");
  if (looksLikePath) {
    const file = path.resolve(ref);
    const suite = parseSuiteFile(file);
    if (!suite) throw new Error(`تعذّر تحميل suite من: ${ref}`);
    return suite;
  }
  const candidates = [path.join(EVALS_DIR, `${ref}.json`), path.join(draftsDir(), `${ref}.json`)];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const suite = parseSuiteFile(c);
      if (suite) return suite;
    }
  }
  throw new Error(`لا توجد suite بالمعرّف: ${ref}`);
}

export function installDraft(name: string): { id: string; path: string } {
  if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) throw new Error("اسم مسودة غير صالح");
  const src = path.join(draftsDir(), name);
  if (!fs.existsSync(src)) throw new Error(`مسودة غير موجودة: ${name}`);
  const suite = parseSuiteFile(src);
  if (!suite) throw new Error(`مسودة غير صالحة: ${name}`);
  const dest = path.join(EVALS_DIR, name);
  if (fs.existsSync(dest)) throw new Error(`توجد suite بنفس الاسم: ${name}`);
  fs.mkdirSync(EVALS_DIR, { recursive: true });
  fs.copyFileSync(src, dest);
  return { id: suite.id, path: dest };
}
