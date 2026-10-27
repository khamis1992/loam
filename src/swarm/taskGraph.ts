/**
 * Task graph for the full pipeline (BUILD_SPEC §6.2, proposal 1).
 *
 * The architecture stage ends its answer with a TASKS_JSON block. The engine
 * parses and validates it deterministically: unique ids, known dependencies,
 * no cycles, and disjoint file ownership between any two tasks that may run
 * concurrently. A valid graph replaces the single implementation stage with
 * one node per task; anything invalid keeps today's single stage (never fails
 * the run), and the reason is recorded.
 */
import path from "node:path";

export const MIN_TASKS = 2;
export const MAX_TASKS = 8;
export const MAX_FILES_PER_TASK = 20;
export const TASK_NODE_PREFIX = "task-";

export interface PlannedTask {
  id: string;
  title: string;
  /** Workspace-relative files or directory prefixes (ending with "/") this task owns. */
  files: string[];
  /** Test files this task writes first (owned as well). */
  tests: string[];
  dependsOn: string[];
  /** Requirement ids (REQ-n) this task satisfies. */
  requirements: string[];
  /** False only with a reason: markup/asset tasks that cannot be unit-tested. */
  tdd: boolean;
  tddReason?: string;
}

export interface TaskGraph { tasks: PlannedTask[]; waves: string[][] }
export type TaskGraphResult = { ok: true; graph: TaskGraph; warnings: string[] } | { ok: false; errors: string[] };

const TEST_PATH = /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|(?:^|\/)[^/]+_test\.go$|(?:^|\/)(?:tests?|__tests__)\//i;

/** Normalizes a model-written path; returns null when it is unsafe or outside the workspace. */
export function normalizeOwnedPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replaceAll("\\", "/");
  if (!trimmed || trimmed.length > 200 || trimmed.includes("\0")) return null;
  if (trimmed.startsWith("/") || /^[a-z]:/i.test(trimmed)) return null;
  const isDir = trimmed.endsWith("/");
  const normalized = path.posix.normalize(trimmed);
  if (normalized === "." || normalized.startsWith("..") || normalized.startsWith(".loam/") || normalized === ".loam" || normalized.startsWith(".git/") || normalized === ".git") return null;
  if (/[*?[\]{}]/.test(normalized)) return null;
  return isDir ? `${normalized.replace(/\/+$/, "")}/` : normalized.replace(/\/+$/, "");
}

/** True when two owned entries overlap (same file, or one is a directory containing the other). */
export function ownershipOverlaps(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith("/") && b.startsWith(a)) return true;
  if (b.endsWith("/") && a.startsWith(b)) return true;
  return false;
}

/** True when `rel` is inside a task's ownership set. */
export function isOwnedBy(task: Pick<PlannedTask, "files" | "tests">, rel: string): boolean {
  const target = normalizeOwnedPath(rel);
  if (!target) return false;
  return [...task.files, ...task.tests].some(owned => owned === target || (owned.endsWith("/") && target.startsWith(owned)));
}

/** Extracts the JSON object that follows the TASKS_JSON marker (fenced or bare). */
export function extractTasksJson(text: string): unknown | null {
  const marker = text.lastIndexOf("TASKS_JSON");
  if (marker < 0) return null;
  const rest = text.slice(marker + "TASKS_JSON".length);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(rest);
  const candidate = fenced ? fenced[1]! : rest.slice(rest.indexOf("{"));
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  let depth = 0; let inString = false; let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(candidate.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** Topological levels: every task appears in the first wave after all of its dependencies. */
export function computeWaves(tasks: readonly PlannedTask[]): string[][] | null {
  const remaining = new Map(tasks.map(task => [task.id, new Set(task.dependsOn)]));
  const waves: string[][] = [];
  while (remaining.size) {
    const wave = [...remaining.entries()].filter(([, deps]) => deps.size === 0).map(([id]) => id).sort();
    if (!wave.length) return null;
    waves.push(wave);
    for (const id of wave) remaining.delete(id);
    for (const deps of remaining.values()) for (const id of wave) deps.delete(id);
  }
  return waves;
}

/** Transitive dependency closure, used to decide which pairs may run concurrently. */
function ancestors(tasks: readonly PlannedTask[]): Map<string, Set<string>> {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const memo = new Map<string, Set<string>>();
  const visit = (id: string): Set<string> => {
    const cached = memo.get(id); if (cached) return cached;
    const result = new Set<string>();
    memo.set(id, result);
    for (const dep of byId.get(id)?.dependsOn ?? []) { result.add(dep); for (const deeper of visit(dep)) result.add(deeper); }
    return result;
  };
  for (const task of tasks) visit(task.id);
  return memo;
}

/** Parses and validates the architecture stage's TASKS_JSON block. */
export function parseTaskGraph(text: string, opts: { knownRequirements?: readonly string[] } = {}): TaskGraphResult {
  const raw = extractTasksJson(text);
  if (raw === null) return { ok: false, errors: ["no TASKS_JSON block found"] };
  const list = typeof raw === "object" && raw !== null && Array.isArray((raw as { tasks?: unknown }).tasks) ? (raw as { tasks: unknown[] }).tasks : null;
  if (!list) return { ok: false, errors: ["TASKS_JSON must be an object with a tasks array"] };
  const errors: string[] = []; const warnings: string[] = [];
  if (list.length < MIN_TASKS) errors.push(`at least ${MIN_TASKS} tasks are required for a task graph (got ${list.length}); a single task stays one implementation stage`);
  if (list.length > MAX_TASKS) errors.push(`at most ${MAX_TASKS} tasks are allowed (got ${list.length}); merge smaller tasks`);
  const tasks: PlannedTask[] = [];
  const seen = new Set<string>();
  list.slice(0, MAX_TASKS).forEach((item, index) => {
    const label = `task #${index + 1}`;
    if (typeof item !== "object" || item === null) { errors.push(`${label} is not an object`); return; }
    const t = item as Record<string, unknown>;
    const id = typeof t.id === "string" ? t.id.trim() : "";
    if (!/^T\d{1,2}$/.test(id)) { errors.push(`${label}: id must look like T1..T99`); return; }
    if (seen.has(id)) { errors.push(`${label}: duplicate id ${id}`); return; }
    seen.add(id);
    const title = typeof t.title === "string" && t.title.trim() ? t.title.trim().slice(0, 120) : id;
    const filesRaw = Array.isArray(t.files) ? t.files : [];
    const testsRaw = Array.isArray(t.tests) ? t.tests : [];
    const files = filesRaw.map(normalizeOwnedPath).filter((p): p is string => p !== null);
    const tests = testsRaw.map(normalizeOwnedPath).filter((p): p is string => p !== null);
    if (files.length !== filesRaw.length || tests.length !== testsRaw.length) errors.push(`${id}: every path must be workspace-relative, without .., globs, .loam/ or .git/`);
    if (!files.length) errors.push(`${id}: must own at least one file`);
    if (files.length + tests.length > MAX_FILES_PER_TASK) errors.push(`${id}: owns more than ${MAX_FILES_PER_TASK} paths; split the task`);
    for (const test of tests) if (!TEST_PATH.test(test)) errors.push(`${id}: ${test} is not a recognized test path`);
    const dependsOn = Array.isArray(t.dependsOn) ? t.dependsOn.filter((d): d is string => typeof d === "string").map(d => d.trim()) : [];
    const requirements = Array.isArray(t.requirements) ? t.requirements.filter((r): r is string => typeof r === "string" && /^REQ-\d{1,3}$/.test(r.trim())).map(r => r.trim()) : [];
    const tdd = t.tdd !== false;
    const tddReason = typeof t.tddReason === "string" ? t.tddReason.trim().slice(0, 200) : undefined;
    if (!tdd && !tddReason) errors.push(`${id}: tdd:false requires a tddReason`);
    if (tdd && !tests.length) errors.push(`${id}: a TDD task must name at least one test file it writes first`);
    tasks.push({ id, title, files, tests, dependsOn, requirements, tdd, ...(tddReason ? { tddReason } : {}) });
  });
  const ids = new Set(tasks.map(task => task.id));
  for (const task of tasks) for (const dep of task.dependsOn) if (!ids.has(dep)) errors.push(`${task.id}: depends on unknown task ${dep}`);
  if (errors.length) return { ok: false, errors };
  const waves = computeWaves(tasks);
  if (!waves) return { ok: false, errors: ["task dependencies contain a cycle"] };
  const closure = ancestors(tasks);
  for (let i = 0; i < tasks.length; i++) for (let j = i + 1; j < tasks.length; j++) {
    const a = tasks[i]!, b = tasks[j]!;
    const ordered = closure.get(a.id)!.has(b.id) || closure.get(b.id)!.has(a.id);
    if (ordered) continue;
    for (const pa of [...a.files, ...a.tests]) for (const pb of [...b.files, ...b.tests])
      if (ownershipOverlaps(pa, pb)) errors.push(`${a.id} and ${b.id} may run concurrently but both own ${pa === pb ? pa : `${pa} / ${pb}`}; add a dependency or split ownership`);
  }
  if (errors.length) return { ok: false, errors };
  if (opts.knownRequirements?.length) {
    const known = new Set(opts.knownRequirements);
    for (const task of tasks) for (const req of task.requirements) if (!known.has(req)) warnings.push(`${task.id} references ${req}, which the requirements spec does not define`);
    const covered = new Set(tasks.flatMap(task => task.requirements));
    for (const req of known) if (!covered.has(req)) warnings.push(`${req} is not assigned to any task`);
  }
  return { ok: true, graph: { tasks, waves }, warnings };
}

/** Stage node id for a planned task. */
export function taskNodeId(taskId: string): string { return `${TASK_NODE_PREFIX}${taskId.toLowerCase()}`; }

/** Instruction text appended to one task node's stage prompt. */
export function taskInstruction(task: PlannedTask): string {
  const owned = [...task.files, ...task.tests].join(", ");
  const tdd = task.tdd
    ? `Follow test-first order strictly: (1) write the failing test file(s) ${task.tests.join(", ")} covering ${task.requirements.join(", ") || "this task's behaviour"}; (2) run them alone with shell_run and see them fail; (3) write the minimal code; (4) run them again until they pass. Code writes are refused by the engine until a test exists and has been run.`
    : `This task is exempt from test-first (${task.tddReason ?? "no reason"}); still verify by running the project's tests once before answering.`;
  return `You implement ONE planned task: ${task.id} — ${task.title}. You may write only these paths: ${owned}. Other tasks own every other file and run in parallel; read them, never write them. ${tdd}`;
}
