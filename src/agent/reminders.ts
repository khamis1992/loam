import type { ChatMessage } from "../ollama.js";

/** Tag that marks a harness-generated reminder. Reminders are model-facing
 *  context, never user-facing output: the UI filters them out. */
export const REMINDER_TAG = "system-reminder";
export const REMINDER_OPEN = `<${REMINDER_TAG}>`;
export const REMINDER_CLOSE = `</${REMINDER_TAG}>`;

/** The reminder kinds the loop knows how to produce. */
export type ReminderKind = "todo_stale" | "file_changed" | "plan_mode" | "memory_updated" | "file_touched";

/** Steps without a todo/plan update before a stale-todo reminder is injected. */
export const DEFAULT_TODO_STALE_STEPS = 8;

/** Tool names that count as a live-task-list update. `todo_write` is the
 *  dedicated tool; `plan` is the existing live task list. */
export const TODO_UPDATE_TOOLS: ReadonlySet<string> = new Set(["todo_write", "plan"]);

/** Tool names that change durable memory and therefore supersede assumptions. */
export const MEMORY_UPDATE_TOOLS: ReadonlySet<string> = new Set(["memory_store", "memory_add"]);

/** Wrap free text in the reminder tag. The body is trimmed so a reminder is
 *  always exactly one tagged block. */
export function injectReminder(text: string): string {
  const body = text.trim();
  if (!body) throw new Error("reminder text must not be empty");
  return `${REMINDER_OPEN}\n${body}\n${REMINDER_CLOSE}`;
}

/** Build a user-role message carrying a reminder. The user role is what makes
 *  the model read it as a fresh instruction on the next turn. */
export function reminderMessage(text: string): ChatMessage {
  return { role: "user", content: injectReminder(text) };
}

/** True when content is exactly one reminder block. */
export function isReminderContent(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith(REMINDER_OPEN) && trimmed.endsWith(REMINDER_CLOSE);
}

/** True when a message is a reminder. Only user-role tagged blocks count, so a
 *  real user message that happens to mention the tag is never hidden. */
export function isReminderMessage(message: { role: string; content: string }): boolean {
  return message.role === "user" && isReminderContent(message.content);
}

/** Drop reminders so a transcript never renders harness context. */
export function visibleMessages<T extends { role: string; content: string }>(messages: readonly T[]): T[] {
  return messages.filter((m) => !isReminderMessage(m));
}

export function todoStaleReminder(steps: number): string {
  return `Your task list has not been updated for ${steps} steps. Keep the live task list current: mark each finished item done as soon as you have evidence, keep exactly one item in progress, and add newly discovered work as new items. Send the full updated list before continuing.`;
}

export function fileChangedReminder(path: string): string {
  return `The file \`${path}\` changed on disk since it was last read — by you, the user, or an external tool. Re-read it before editing or quoting it, and do not rely on the earlier contents.`;
}

export function planModeReminder(): string {
  return "You are in PLAN mode: read-only exploration and design only. Do not modify files, run mutating commands, or claim implementation is complete. Present the plan for approval before making changes.";
}

export function memoryUpdatedReminder(): string {
  return "Project memory was updated during this run. Re-check the facts you rely on before continuing; a new or changed memory may supersede an earlier assumption.";
}

/** Cross-session file-touch notice (jcode J8): another session wrote a file this
 *  session had already read, so its view of that file is stale. */
export function fileTouchedReminder(notice: { path: string; writer: string; summary: string; preview?: string[]; edits?: number }): string {
  const head = notice.writer
    ? `Another agent (${notice.writer}) changed the file \`${notice.path}\` that you already read`
    : `Another agent changed the file \`${notice.path}\` that you already read`;
  const count = notice.edits && notice.edits > 1 ? ` (${notice.edits} edits since)` : "";
  const lines = notice.preview && notice.preview.length > 0 ? `\n${notice.preview.join("\n")}` : "";
  return `${head}${count}: ${notice.summary}.${lines}\nRe-read it with file_read before editing or quoting it; your earlier view of this file is stale.`;
}

/** Build a reminder for a known kind. `detail` is the step count for a stale
 *  todo list, the file path for an external change, and a JSON-encoded notice
 *  for a cross-session file touch. */
export function buildReminder(kind: ReminderKind, detail?: string): string {
  switch (kind) {
    case "todo_stale":
      return todoStaleReminder(Number(detail ?? DEFAULT_TODO_STALE_STEPS));
    case "file_changed":
      return fileChangedReminder(detail ?? "the file");
    case "plan_mode":
      return planModeReminder();
    case "memory_updated":
      return memoryUpdatedReminder();
    case "file_touched":
      try {
        const notice = JSON.parse(detail ?? "") as Parameters<typeof fileTouchedReminder>[0];
        if (notice && typeof notice.path === "string") return fileTouchedReminder(notice);
      } catch {
        /* fall through to the generic wording */
      }
      return fileTouchedReminder({ path: detail ?? "a file", writer: "", summary: "changed" });
  }
}

export interface ReminderChannelOptions {
  /** Steps without a todo/plan update before a stale-todo reminder. */
  todoStaleAfter?: number;
  /** Whether plan mode is active for this run. */
  planMode?: boolean;
}

/** Collects reminders for one run and turns them into user-role messages.
 *  Event-driven reminders (external file change, memory update) are queued by
 *  the caller; staleness and plan mode are evaluated per step. */
export class ReminderChannel {
  private pending: string[] = [];
  private lastTodoStep = 0;
  private lastTodoReminderStep = -1;
  private planMode: boolean;
  private planModeAnnounced = false;
  private readonly todoStaleAfter: number;

  constructor(options: ReminderChannelOptions = {}) {
    this.todoStaleAfter = options.todoStaleAfter ?? DEFAULT_TODO_STALE_STEPS;
    this.planMode = options.planMode ?? false;
  }

  /** Record a todo/plan update so staleness restarts from this step. */
  noteTodoUpdate(step: number): void {
    this.lastTodoStep = step;
    this.lastTodoReminderStep = -1;
  }

  /** Queue a reminder for a file that changed outside the run. */
  fileChanged(path: string): void {
    this.pending.push(fileChangedReminder(path));
  }

  /** Queue a cross-session file-touch notice: another session wrote a file this
   *  session had already read (jcode J8). */
  fileTouched(notice: { path: string; writer: string; summary: string; preview?: string[]; edits?: number }): void {
    this.pending.push(fileTouchedReminder(notice));
  }

  /** Queue a reminder for a durable memory update. */
  memoryUpdated(): void {
    this.pending.push(memoryUpdatedReminder());
  }

  /** Track plan mode. The reminder is announced once per activation. */
  setPlanMode(active: boolean): void {
    this.planMode = active;
    if (!active) this.planModeAnnounced = false;
  }

  /** Reminders due at this step (plan mode once, then a stale-todo nudge every
   *  `todoStaleAfter` silent steps). Idempotent for a given step. */
  due(step: number): string[] {
    const due: string[] = [];
    if (this.planMode && !this.planModeAnnounced) {
      this.planModeAnnounced = true;
      due.push(planModeReminder());
    }
    const silent = step - Math.max(this.lastTodoStep, this.lastTodoReminderStep);
    if (silent >= this.todoStaleAfter) {
      this.lastTodoReminderStep = step;
      due.push(todoStaleReminder(silent));
    }
    return due;
  }

  /** Pending event-driven reminders plus those due at this step, then clears. */
  drain(step: number): string[] {
    const all = [...this.pending, ...this.due(step)];
    this.pending = [];
    return all;
  }

  /** Drain into user-role tagged messages ready to append to the transcript. */
  drainMessages(step: number): ChatMessage[] {
    return this.drain(step).map((text) => reminderMessage(text));
  }

  get pendingCount(): number {
    return this.pending.length;
  }
}
