import fs from "node:fs";
import path from "node:path";
import type { AppProject } from "./types.js";

const TASK_APP = /\b(?:to[- ]?do(?:\s+list)?|task(?:\s+|-)(?:list|manager|tracker)|checklist)\b/i;
const TASK_APP_AR = /(?:قائمة\s+(?:مهام|مهمات)|تطبيق\s+مهام|مهام\s+بسيطة)/i;
const EXTENDED_SCOPE = /\b(?:auth(?:entication)?|login|sign[ -]?up|multi[ -]?user|collaborat\w*|backend|server|database|postgres|mysql|mongodb|api\b|payment|stripe|e[ -]?commerce|shopping\s+cart|social|chat|real[ -]?time|mobile|desktop|electron|ai[ -]?(?:powered|agent)|integration|sync)\b/i;

export function isSimpleCrudRequest(prompt: string): boolean {
  const text = prompt.trim();
  return text.length > 0 && text.length <= 500 && !text.includes("\n")
    && (TASK_APP.test(text) || TASK_APP_AR.test(text)) && !EXTENDED_SCOPE.test(text);
}

const STORE = `export type Todo = {
  id: string;
  text: string;
  completed: boolean;
  createdAt: number;
};

export type TodoFilter = "all" | "active" | "completed";

export function addTodo(todos: Todo[], text: string, now = Date.now(), id = crypto.randomUUID()): Todo[] {
  const trimmed = text.trim();
  if (!trimmed) return todos;
  return [{ id, text: trimmed.slice(0, 200), completed: false, createdAt: now }, ...todos];
}

export function toggleTodo(todos: Todo[], id: string): Todo[] {
  return todos.map((todo) => todo.id === id ? { ...todo, completed: !todo.completed } : todo);
}

export function deleteTodo(todos: Todo[], id: string): Todo[] {
  return todos.filter((todo) => todo.id !== id);
}

export function clearCompleted(todos: Todo[]): Todo[] {
  return todos.filter((todo) => !todo.completed);
}

export function filterTodos(todos: Todo[], filter: TodoFilter): Todo[] {
  if (filter === "active") return todos.filter((todo) => !todo.completed);
  if (filter === "completed") return todos.filter((todo) => todo.completed);
  return todos;
}

export function parseTodos(raw: string | null): Todo[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const ids = new Set<string>();
    return value.slice(0, 500).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const todo = item as Record<string, unknown>;
      if (typeof todo.id !== "string" || !todo.id || ids.has(todo.id)) return [];
      if (typeof todo.text !== "string" || !todo.text.trim() || typeof todo.completed !== "boolean") return [];
      if (typeof todo.createdAt !== "number" || !Number.isFinite(todo.createdAt)) return [];
      ids.add(todo.id);
      return [{ id: todo.id, text: todo.text.trim().slice(0, 200), completed: todo.completed, createdAt: todo.createdAt }];
    });
  } catch {
    return [];
  }
}
`;

const PAGE = `import { useEffect, useId, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Check, CheckCircle2, Circle, ListTodo, Plus, Trash2 } from "lucide-react";
import { addTodo, clearCompleted, deleteTodo, filterTodos, parseTodos, toggleTodo } from "../todoStore";
import type { TodoFilter } from "../todoStore";

const STORAGE_KEY = "tidy.todos.v1";
const FILTERS: Array<{ id: TodoFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "completed", label: "Completed" },
];

export default function Index() {
  const inputId = useId();
  const [todos, setTodos] = useState(() => {
    try { return parseTodos(window.localStorage.getItem(STORAGE_KEY)); } catch { return []; }
  });
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState<TodoFilter>("all");
  const [announcement, setAnnouncement] = useState("");
  const [storageError, setStorageError] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [todos]);

  const activeCount = todos.filter((todo) => !todo.completed).length;
  const completedCount = todos.length - activeCount;
  const progress = todos.length ? Math.round((completedCount / todos.length) * 100) : 0;
  const visible = useMemo(() => filterTodos(todos, filter), [todos, filter]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.trim()) return;
    setTodos((current) => addTodo(current, draft));
    setDraft("");
    setFilter("all");
    setAnnouncement("Task added.");
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#tasks" aria-label="Tidy home">
          <span className="brand-mark"><Check size={19} strokeWidth={2.8} /></span>
          <span>Tidy</span>
        </a>
        <span className="workspace-label"><span className="status-dot" /> Personal workspace</span>
      </header>

      <main className="workspace" id="tasks">
        <aside className="intro">
          <p className="eyebrow"><ListTodo size={15} /> Your day, simplified</p>
          <h1>Make space for what matters.</h1>
          <p className="intro-copy">A quiet place for the things you need to do. Add a task, make progress, and enjoy the feeling of done.</p>
          <div className="progress-card">
            <div className="progress-heading">
              <span>Today&apos;s progress</span>
              <strong>{progress}%</strong>
            </div>
            <progress value={progress} max={100} aria-label="Task completion progress" />
            <p>{completedCount === 0 ? "Your finished tasks will appear here." : completedCount + " of " + todos.length + " tasks completed"}</p>
          </div>
          <div className="gentle-note">
            <CheckCircle2 size={19} />
            <p><strong>Small steps count.</strong><br />Start with one thing you can finish today.</p>
          </div>
        </aside>

        <section className="task-panel" aria-labelledby="list-heading">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">MY LIST</p>
              <h2 id="list-heading">Tasks for today</h2>
            </div>
            <span className="count-badge">{activeCount} {activeCount === 1 ? "task" : "tasks"} left</span>
          </div>

          <form className="add-form" onSubmit={submit}>
            <label className="sr-only" htmlFor={inputId}>New task</label>
            <input
              id={inputId}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="What would you like to get done?"
              maxLength={200}
              autoComplete="off"
            />
            <button className="add-button" type="submit" disabled={!draft.trim()}>
              <Plus size={18} /> <span>Add task</span>
            </button>
          </form>

          <div className="list-tools">
            <div className="filters" aria-label="Filter tasks">
              {FILTERS.map((item) => (
                <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
                  {item.label}
                </button>
              ))}
            </div>
            {completedCount > 0 && (
              <button className="clear-button" type="button" onClick={() => { setTodos((current) => clearCompleted(current)); setAnnouncement("Completed tasks cleared."); }}>
                Clear completed
              </button>
            )}
          </div>

          {visible.length > 0 ? (
            <ul className="todo-list">
              {visible.map((todo) => (
                <li className={todo.completed ? "todo-item is-complete" : "todo-item"} key={todo.id} data-task-id={todo.id}>
                  <label className="todo-check">
                    <input
                      type="checkbox"
                      checked={todo.completed}
                      onChange={() => { setTodos((current) => toggleTodo(current, todo.id)); setAnnouncement(todo.completed ? "Task marked active." : "Task completed."); }}
                      aria-label={(todo.completed ? "Mark as active: " : "Mark as complete: ") + todo.text}
                    />
                    <span className="custom-check" aria-hidden="true">{todo.completed ? <CheckCircle2 size={23} /> : <Circle size={23} />}</span>
                    <span className="todo-text">{todo.text}</span>
                  </label>
                  <button className="delete-button" type="button" aria-label={"Delete task: " + todo.text} onClick={() => { setTodos((current) => deleteTodo(current, todo.id)); setAnnouncement("Task deleted."); }}>
                    <Trash2 size={17} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty-state">
              <span><Check size={27} /></span>
              <h3>{filter === "completed" ? "Nothing finished yet" : filter === "active" ? "You’re all caught up" : "A fresh start"}</h3>
              <p>{filter === "all" ? "Add your first task above and take it one step at a time." : "Try another filter to see your tasks."}</p>
              {filter !== "all" && <button type="button" onClick={() => setFilter("all")}>Show all tasks</button>}
            </div>
          )}

          <footer className="panel-footer">
            <span>{storageError ? "Changes will last for this session only." : "Saved automatically in this browser."}</span>
            <span>{todos.length} total</span>
          </footer>
        </section>
      </main>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    </div>
  );
}
`;

const CSS = `@import "tailwindcss";

:root {
  font-family: Inter, "Segoe UI", Arial, sans-serif;
  color: #292d26;
  background: #f7f7f2;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  --ink: #292d26;
  --muted: #73796e;
  --green: #536b4c;
  --green-dark: #40543b;
  --line: #e6e8df;
  --paper: #ffffff;
}

* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; min-height: 100vh; }
button, input { font: inherit; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; }
button, a, input { -webkit-tap-highlight-color: transparent; }
button:focus-visible, a:focus-visible, input:focus-visible { outline: 3px solid #9caf93; outline-offset: 3px; }

.app-shell { min-height: 100vh; background: #f7f7f2; }
.topbar { height: 80px; max-width: 1160px; margin: 0 auto; padding: 0 32px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #e3e5dc; }
.brand { display: inline-flex; align-items: center; gap: 10px; color: var(--ink); text-decoration: none; font-size: 23px; font-weight: 750; letter-spacing: -0.6px; }
.brand-mark { display: grid; place-items: center; width: 34px; height: 34px; color: white; background: var(--green); border-radius: 10px; }
.workspace-label { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
.status-dot { width: 7px; height: 7px; border-radius: 50%; background: #7c966f; }
.workspace { max-width: 1100px; margin: 0 auto; padding: 72px 32px 64px; display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.25fr); gap: 76px; align-items: start; }
.intro { padding-top: 22px; }
.eyebrow { display: flex; align-items: center; gap: 8px; margin: 0 0 20px; color: var(--green); font-size: 13px; font-weight: 700; letter-spacing: 0.2px; }
h1 { margin: 0; max-width: 400px; font-size: clamp(40px, 4.2vw, 56px); line-height: 1.07; letter-spacing: -2.4px; font-weight: 720; }
.intro-copy { max-width: 390px; margin: 24px 0 32px; color: var(--muted); font-size: 16px; line-height: 1.75; }
.progress-card { max-width: 370px; padding: 21px 22px; background: #eef1e9; border: 1px solid #e1e7da; border-radius: 16px; }
.progress-heading { display: flex; justify-content: space-between; align-items: center; font-size: 13px; font-weight: 650; }
.progress-heading strong { color: var(--green); font-size: 15px; }
progress { display: block; width: 100%; height: 7px; margin: 17px 0 12px; border: 0; border-radius: 20px; overflow: hidden; background: #dce3d4; }
progress::-webkit-progress-bar { background: #dce3d4; border-radius: 20px; }
progress::-webkit-progress-value { background: var(--green); border-radius: 20px; }
progress::-moz-progress-bar { background: var(--green); border-radius: 20px; }
.progress-card p { margin: 0; color: var(--muted); font-size: 12px; }
.gentle-note { display: flex; gap: 12px; margin: 26px 4px 0; color: #829177; }
.gentle-note svg { flex: 0 0 auto; margin-top: 3px; }
.gentle-note p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.7; }
.gentle-note strong { color: #596453; font-weight: 650; }

.task-panel { overflow: hidden; background: var(--paper); border: 1px solid #e5e7de; border-radius: 22px; box-shadow: 0 18px 50px -35px rgba(46, 57, 40, 0.35); }
.panel-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 30px 30px 22px; }
.section-kicker { margin: 0 0 8px; color: #8b9284; font-size: 10px; font-weight: 750; letter-spacing: 1.6px; }
.panel-heading h2 { margin: 0; font-size: 22px; line-height: 1.3; letter-spacing: -0.5px; }
.count-badge { flex: 0 0 auto; padding: 7px 11px; border-radius: 8px; background: #f0f3eb; color: var(--green); font-size: 11px; font-weight: 650; }
.add-form { display: flex; gap: 10px; margin: 0 30px; padding: 6px; border: 1px solid #dfe3d8; border-radius: 12px; background: #fbfcf9; }
.add-form:focus-within { border-color: #98aa8e; box-shadow: 0 0 0 3px #eef2e9; }
.add-form input { min-width: 0; flex: 1; padding: 10px 11px; border: 0; outline: 0; color: var(--ink); background: transparent; font-size: 13px; }
.add-form input::placeholder { color: #959c8f; }
.add-button { display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 42px; padding: 0 15px; border: 0; border-radius: 8px; background: var(--green); color: white; font-size: 12px; font-weight: 650; transition: background 150ms ease; }
.add-button:hover:not(:disabled) { background: var(--green-dark); }
.add-button:disabled { background: #d9dfd3; color: #87917f; }
.list-tools { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin: 25px 30px 0; padding-bottom: 16px; border-bottom: 1px solid var(--line); }
.filters { display: flex; gap: 4px; }
.filters button { padding: 7px 11px; border: 0; border-radius: 7px; color: #82897b; background: transparent; font-size: 11px; font-weight: 600; }
.filters button:hover { color: var(--ink); background: #f4f5f0; }
.filters button[aria-pressed="true"] { color: var(--green-dark); background: #edf1e8; }
.clear-button { padding: 6px 0; border: 0; color: #8a9182; background: transparent; font-size: 10px; }
.clear-button:hover { color: #9b5147; }
.todo-list { list-style: none; margin: 0; padding: 5px 30px 12px; }
.todo-item { display: flex; align-items: center; gap: 10px; min-height: 64px; border-bottom: 1px solid #eff0eb; }
.todo-item:last-child { border-bottom: 0; }
.todo-check { min-width: 0; flex: 1; display: flex; align-items: center; gap: 12px; padding: 13px 0; cursor: pointer; }
.todo-check input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.todo-check input:focus-visible + .custom-check { outline: 3px solid #9caf93; outline-offset: 3px; border-radius: 50%; }
.custom-check { display: flex; flex: 0 0 auto; color: #b2b9aa; }
.is-complete .custom-check { color: #79916d; }
.todo-text { min-width: 0; overflow-wrap: anywhere; font-size: 13px; line-height: 1.55; }
.is-complete .todo-text { color: #969d90; text-decoration: line-through; }
.delete-button { display: grid; place-items: center; flex: 0 0 auto; width: 34px; height: 34px; padding: 0; border: 0; border-radius: 8px; color: #abb1a5; background: transparent; }
.delete-button:hover { color: #a04f45; background: #faf0ee; }
.empty-state { display: flex; flex-direction: column; align-items: center; padding: 48px 25px 51px; text-align: center; }
.empty-state > span { display: grid; place-items: center; width: 54px; height: 54px; margin-bottom: 17px; border-radius: 50%; color: #7e9672; background: #eff3ea; }
.empty-state h3 { margin: 0 0 8px; font-size: 16px; }
.empty-state p { max-width: 270px; margin: 0; color: var(--muted); font-size: 12px; line-height: 1.65; }
.empty-state button { margin-top: 16px; padding: 7px 12px; border: 1px solid var(--line); border-radius: 7px; color: var(--green); background: white; font-size: 11px; }
.panel-footer { display: flex; justify-content: space-between; gap: 12px; padding: 16px 30px; border-top: 1px solid var(--line); color: #939a8d; background: #fcfcfa; font-size: 10px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

@media (max-width: 820px) {
  .workspace { grid-template-columns: 1fr; gap: 36px; padding-top: 42px; }
  .intro { padding-top: 0; }
  h1 { max-width: 540px; }
  .intro-copy, .progress-card { max-width: 100%; }
  .gentle-note { display: none; }
}
@media (max-width: 520px) {
  .topbar { height: 68px; padding: 0 20px; }
  .workspace-label { font-size: 0; gap: 0; }
  .workspace { padding: 32px 16px 40px; gap: 28px; }
  h1 { font-size: 40px; letter-spacing: -1.8px; }
  .intro-copy { margin: 18px 0 24px; font-size: 14px; }
  .panel-heading { padding: 24px 20px 18px; }
  .add-form { margin: 0 20px; }
  .add-button { padding: 0 12px; }
  .add-button span { display: none; }
  .list-tools { margin: 21px 20px 0; }
  .filters button { padding: 7px 9px; }
  .clear-button { max-width: 60px; line-height: 1.35; text-align: right; }
  .todo-list { padding: 5px 20px 12px; }
  .panel-footer { padding: 15px 20px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
}
`;

const DESIGN = `# Tidy — design

## Direction & Layout
A calm personal workspace with an editorial introduction on the left and a focused task card on the right. The desktop content is 1100px wide with 76px between columns. Below 820px the introduction stacks above the task card. The task remains the primary action on every viewport.

## Tokens
- Canvas #f7f7f2; paper #ffffff; primary text #292d26; muted text #73796e.
- Action green #536b4c with hover #40543b; pale sage surfaces #eef1e9.
- Body text 16px; task text 13px; hero 40px to 56px; panel title 22px.
- Form controls are at least 42px high. Panel radius 22px; input radius 12px; small control radius 8px.

## Patterns & States
Tasks have active, completed, hover, keyboard-focus, and delete states. The empty state changes for all, active, and completed filters. Add is disabled for blank input. Task text wraps without overflowing, filters expose aria-pressed, and completion uses a labelled native checkbox. A live region announces mutations. Storage failure is visible without blocking the session.

## Media
No stock imagery is needed; simple Lucide task icons support scanning. The layout becomes one column below 820px. Below 520px page gutters reduce to 16px and the add action keeps an accessible icon-only presentation. Motion is removed when the user requests reduced motion.
`;

const TESTS = `import test from "node:test";
import assert from "node:assert/strict";
import { addTodo, clearCompleted, deleteTodo, filterTodos, parseTodos, toggleTodo } from "../src/todoStore.ts";

const todo = { id: "one", text: "Finish the proposal", completed: false, createdAt: 1 };

test("add trims input, ignores blank tasks, and caps task length", () => {
  assert.deepEqual(addTodo([], "  "), []);
  assert.deepEqual(addTodo([], "  Buy milk  ", 2, "two"), [{ id: "two", text: "Buy milk", completed: false, createdAt: 2 }]);
  assert.equal(addTodo([], "x".repeat(250))[0].text.length, 200);
});

test("complete and delete update only the selected task", () => {
  const list = addTodo([todo], "Water the plants", 2, "two");
  const toggled = toggleTodo(list, "one");
  assert.equal(toggled.find((item) => item.id === "one").completed, true);
  assert.equal(toggled.find((item) => item.id === "two").completed, false);
  assert.deepEqual(deleteTodo(toggled, "one").map((item) => item.id), ["two"]);
});

test("filters and clear completed preserve active tasks", () => {
  const list = [{ ...todo, completed: true }, { ...todo, id: "two", text: "Active" }];
  assert.deepEqual(filterTodos(list, "active").map((item) => item.id), ["two"]);
  assert.deepEqual(filterTodos(list, "completed").map((item) => item.id), ["one"]);
  assert.deepEqual(clearCompleted(list).map((item) => item.id), ["two"]);
});

test("saved tasks round-trip and malformed storage is safe", () => {
  const list = addTodo([todo], "Persist me", 2, "two");
  assert.deepEqual(parseTodos(JSON.stringify(list)), list);
  assert.deepEqual(parseTodos("not json"), []);
  assert.deepEqual(parseTodos(JSON.stringify([{ id: "bad", text: 3 }])), []);
});
`;

const PACKAGE = `{
  "name": "tidy-tasks",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "engines": { "node": ">=24.0.0" },
  "scripts": {
    "dev": "vite",
    "check": "node --experimental-strip-types --test tests/todos.check.mjs",
    "lint": "tsc --noEmit && node --check scripts/link-deps.mjs",
    "typecheck": "tsc --noEmit",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "clsx": "^2.1.1",
    "lucide-react": "^0.557.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "tailwind-merge": "^3.7.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.1.18",
    "@types/node": "^22.10.0",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^5.1.4",
    "tailwindcss": "^4.1.18",
    "tw-animate-css": "^1.4.0",
    "typescript": "^5.9.3",
    "vite": "^7.3.7"
  }
}
`;

const LINK_DEPS = `import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(appDir, "node_modules");
if (fs.existsSync(path.join(target, ".bin"))) process.exit(0);
if (fs.existsSync(target)) throw new Error("node_modules exists without .bin; restore the app dependencies before verifying.");
const depsDir = process.env.LOAM_DEPS_DIR;
if (!depsDir || !fs.existsSync(path.join(depsDir, "node_modules", ".bin"))) {
  throw new Error("Shared Loam dependencies are not ready. Reopen the project and run the scaffold step first.");
}
fs.symlinkSync(path.join(depsDir, "node_modules"), target, process.platform === "win32" ? "junction" : "dir");
`;

export function buildSimpleCrudApp(project: Pick<AppProject, "workspaceDir" | "appDir">): void {
  const appDir = path.join(project.workspaceDir, project.appDir);
  const files: Record<string, string> = {
    "package.json": PACKAGE,
    "index.html": `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <meta name="theme-color" content="#f7f7f2" />\n    <meta name="description" content="Tidy is a calm, private task list for making progress one step at a time." />\n    <title>Tidy — Your day, simplified</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`,
    "src/main.tsx": `import { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nimport Index from "./pages/Index";\nimport "./index.css";\n\nconst container = document.getElementById("root");\nif (!container) throw new Error("Root element #root not found");\ncreateRoot(container).render(<StrictMode><Index /></StrictMode>);\n`,
    "src/App.tsx": `export { default } from "./pages/Index";\n`,
    "src/pages/Index.tsx": PAGE,
    "src/todoStore.ts": STORE,
    "src/index.css": CSS,
    "tests/todos.check.mjs": TESTS,
    "scripts/link-deps.mjs": LINK_DEPS,
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(appDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
  fs.writeFileSync(path.join(project.workspaceDir, "DESIGN.md"), DESIGN, "utf8");
}
