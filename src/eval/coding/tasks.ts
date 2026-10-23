import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../../config.js";
import { log } from "../../log.js";
import type { CodingTask, FileMap, ForbidPattern, TaskCategory, TaskLanguage } from "./types.js";

/** Root of the committed coding-eval fixtures. */
export function codingEvalsDir(): string {
  return path.join(ROOT, "evals", "coding");
}

/** One subdirectory per task: `evals/coding/tasks/<id>/`. */
export function codingTasksDir(): string {
  return path.join(codingEvalsDir(), "tasks");
}

export function taskDir(id: string): string {
  return path.join(codingTasksDir(), id);
}

export function taskFilesDir(id: string): string {
  return path.join(taskDir(id), "files");
}

export function taskTestsDir(id: string): string {
  return path.join(taskDir(id), "tests");
}

export function taskReferenceDir(id: string): string {
  return path.join(taskDir(id), "reference");
}

const CATEGORIES: readonly TaskCategory[] = ["bug-fix", "refactor", "add-test"];
const LANGUAGES: readonly TaskLanguage[] = ["javascript", "typescript", "python"];
const SKIP_DIRS = new Set(["node_modules", ".git"]);

export interface TaskLoadError {
  id: string;
  problems: string[];
}

export interface LoadedTask {
  task: CodingTask;
  dir: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Read a `Record<path, string>` map, rejecting absolute or escaping paths. */
function asFileMap(v: unknown, label: string, problems: string[]): FileMap {
  const out: FileMap = {};
  if (v === undefined) return out;
  if (!isObj(v)) {
    problems.push(`'${label}' must be an object mapping relative paths to file contents`);
    return out;
  }
  for (const [rel, body] of Object.entries(v)) {
    if (typeof body !== "string") {
      problems.push(`'${label}.${rel}' must be a string`);
      continue;
    }
    const norm = rel.replace(/\\/g, "/");
    if (path.isAbsolute(norm) || norm.split("/").includes("..")) {
      problems.push(`'${label}.${rel}' must be a relative path inside the sandbox`);
      continue;
    }
    out[norm] = body;
  }
  return out;
}

/** Read every file under `root` into a relative-path -> contents map. */
export function readTree(root: string): FileMap {
  const out: FileMap = {};
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(root, full).split(path.sep).join("/");
      out[rel] = fs.readFileSync(full, "utf8");
    }
  }
  return out;
}

/** Parse and validate one `task.json`. Returns the problems instead of throwing so
 *  a single malformed fixture cannot hide the rest of the suite. */
export function parseTask(id: string, raw: unknown): { task?: CodingTask; problems: string[] } {
  const problems: string[] = [];
  if (!isObj(raw)) return { problems: ["task.json must be a JSON object"] };
  const str = (k: string): string => (typeof raw[k] === "string" ? (raw[k] as string) : "");

  const title = str("title").trim();
  const category = str("category") as TaskCategory;
  const language = str("language") as TaskLanguage;
  const prompt = str("prompt");
  const testCommand = str("testCommand");

  if (!title) problems.push("missing or empty 'title'");
  if (!CATEGORIES.includes(category)) problems.push(`'category' must be one of ${CATEGORIES.join(", ")}`);
  if (!LANGUAGES.includes(language)) problems.push(`'language' must be one of ${LANGUAGES.join(", ")}`);
  if (!prompt.trim()) problems.push("missing or empty 'prompt'");
  if (!testCommand.trim()) problems.push("missing or empty 'testCommand'");

  const files = asFileMap(raw.files, "files", problems);
  const tests = asFileMap(raw.tests, "tests", problems);
  const reference = asFileMap(raw.reference, "reference", problems);

  const forbidRaw = Array.isArray(raw.forbidPatterns) ? raw.forbidPatterns : [];
  const forbidPatterns: ForbidPattern[] = forbidRaw
    .filter(isObj)
    .map((p) => ({
      path: typeof p.path === "string" ? p.path : "",
      pattern: typeof p.pattern === "string" ? p.pattern : "",
      ...(typeof p.flags === "string" ? { flags: p.flags } : {}),
    }))
    .filter((p) => p.path && p.pattern);

  const num = (k: string): number | undefined =>
    typeof raw[k] === "number" && Number.isFinite(raw[k]) ? (raw[k] as number) : undefined;

  if (problems.length > 0) return { problems };

  const requireFiles = asStringArray(raw.requireFiles);
  return {
    task: {
      id,
      title,
      category,
      language,
      prompt,
      testCommand,
      // Trees may also be declared inline in task.json; loadTask prefers dirs.
      files,
      tests,
      reference,
      ...(requireFiles.length > 0 ? { requireFiles } : {}),
      ...(forbidPatterns.length > 0 ? { forbidPatterns } : {}),
      ...(num("expectExit") !== undefined ? { expectExit: num("expectExit") } : {}),
      ...(num("timeoutSec") !== undefined ? { timeoutSec: num("timeoutSec") } : {}),
      ...(num("maxSteps") !== undefined ? { maxSteps: num("maxSteps") } : {}),
      ...(asStringArray(raw.tags).length > 0 ? { tags: asStringArray(raw.tags) } : {}),
    },
    problems,
  };
}

/** Load one task by id: metadata from `task.json`, trees from sibling folders. */
export function loadTask(id: string): LoadedTask {
  const dir = taskDir(id);
  const file = path.join(dir, "task.json");
  if (!fs.existsSync(file)) throw new Error(`coding task not found: ${id} (expected ${file})`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`coding task ${id}: invalid task.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { task, problems } = parseTask(id, raw);
  if (!task) throw new Error(`coding task ${id}: ${problems.join("; ")}`);

  // A fixture may declare its trees as `files/`, `tests/`, `reference/`
  // directories (preferred, diff-friendly) or inline in task.json.
  const pick = (dir: FileMap, inline: FileMap): FileMap =>
    Object.keys(dir).length > 0 ? dir : inline;
  const files = pick(readTree(taskFilesDir(id)), task.files);
  const tests = pick(readTree(taskTestsDir(id)), task.tests);
  const reference = pick(readTree(taskReferenceDir(id)), task.reference);
  const missing: string[] = [];
  if (Object.keys(files).length === 0) missing.push("files/");
  if (Object.keys(tests).length === 0) missing.push("tests/");
  if (Object.keys(reference).length === 0) missing.push("reference/");
  if (missing.length > 0) {
    throw new Error(`coding task ${id}: missing or empty fixture trees: ${missing.join(", ")}`);
  }

  return { task: { ...task, files, tests, reference }, dir };
}

/** List every valid task id. Invalid fixtures are logged and skipped. */
export function listTaskIds(): string[] {
  const dir = codingTasksDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    if (!fs.existsSync(path.join(dir, id, "task.json"))) {
      log.warn(`coding-eval: skipping ${id} (no task.json)`);
      continue;
    }
    try {
      loadTask(id);
      ids.push(id);
    } catch (err) {
      log.warn(`coding-eval: skipping ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return ids.sort();
}

export function loadAllTasks(): LoadedTask[] {
  return listTaskIds().map((id) => loadTask(id));
}

/** Validate the whole suite at once; used by CI to fail loudly on a broken fixture. */
export function validateSuite(): { tasks: LoadedTask[]; errors: TaskLoadError[] } {
  const tasks: LoadedTask[] = [];
  const errors: TaskLoadError[] = [];
  const dir = codingTasksDir();
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { tasks, errors: [{ id: dir, problems: ["tasks directory is missing"] }] };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    if (!fs.existsSync(path.join(dir, id, "task.json"))) {
      errors.push({ id, problems: ["no task.json"] });
      continue;
    }
    try {
      tasks.push(loadTask(id));
    } catch (err) {
      errors.push({ id, problems: [err instanceof Error ? err.message : String(err)] });
    }
  }
  return { tasks: tasks.sort((a, b) => a.task.id.localeCompare(b.task.id)), errors };
}
