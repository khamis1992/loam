import type { Tool, ToolContext, ToolResult, ToolRegistry } from "./registry.js";
import { bool, num, str, strFirst, strs } from "./registry.js";
import { createMapReduceTool } from "./mapReduce.js";
import type { OllamaClient } from "../ollama.js";
import type { PlanStepStatus } from "../agent/events.js";

const PLAN_STEP_STATUSES: readonly PlanStepStatus[] = ["pending", "doing", "done", "blocked", "cancelled"];

interface ResolvedPlanStep {
  id: string;
  index: number;
  total: number;
  title: string;
  status: PlanStepStatus;
  note?: string;
}

function parsePlanSteps(rawSteps: unknown[], currentStep: number): { steps: ResolvedPlanStep[]; error?: string } {
  const steps: ResolvedPlanStep[] = [];
  for (const raw of rawSteps) {
    if (typeof raw !== "object" || raw === null) continue;
    const step = raw as Record<string, unknown>;
    const title = str(step, "title").trim();
    if (!title) continue;

    const provided = step.status;
    if (provided !== undefined && (typeof provided !== "string" || !PLAN_STEP_STATUSES.includes(provided as PlanStepStatus))) {
      return { steps, error: `step "${title}" has invalid status ${JSON.stringify(provided)}; expected one of ${PLAN_STEP_STATUSES.join(", ")}` };
    }

    const status: PlanStepStatus = provided
      ? (provided as PlanStepStatus)
      : steps.length < currentStep
        ? "done"
        : steps.length === currentStep
          ? "doing"
          : "pending";

    const note = str(step, "note").trim();
    if ((status === "blocked" || status === "cancelled") && !note) {
      return { steps, error: `step "${title}" requires a note when status is ${status}` };
    }

    steps.push({
      id: str(step, "id").trim() || `plan-step-${steps.length}`,
      index: steps.length,
      total: rawSteps.length,
      title,
      status,
      ...(note ? { note } : {}),
    });
  }
  return { steps };
}

export function planTool(): Tool {
  return {
    name: "plan",
    description: "Create or update the task plan shown in the UI.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["steps", "currentStep"],
      properties: {
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            required: ["title"],
            properties: {
              title: { type: "string", maxLength: 120 },
              id: { type: "string", maxLength: 80 },
              status: { enum: [...PLAN_STEP_STATUSES] },
              note: { type: "string", maxLength: 400 },
            },
          },
        },
        currentStep: { type: "integer", minimum: 0 },
        parallel: { type: "boolean", default: false, description: "Allow more than one step to be marked doing." },
      },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const rawSteps = Array.isArray(args.steps) ? args.steps : [];
      const currentStep = num(args, "currentStep", 0);
      const parallel = bool(args, "parallel", false);

      const { steps, error } = parsePlanSteps(rawSteps, currentStep);
      if (error) return { ok: false, content: error };
      if (steps.length === 0) return { ok: false, content: "plan requires at least one step with a title" };

      const doing = steps.filter((s) => s.status === "doing");
      if (doing.length > 1 && !parallel) {
        return { ok: false, content: `at most one step may be "doing" unless parallel is true (found ${doing.length}: ${doing.map((s) => s.title).join(", ")})` };
      }

      ctx.emit({
        type: "plan",
        goal: "Task plan",
        trivial: false,
        steps: steps.map((s) => ({ id: s.id, title: s.title, instruction: s.title, successCriteria: "", status: s.status, ...(s.note ? { note: s.note } : {}) })),
        source: "model",
      });
      for (const s of steps) ctx.emit({ type: "plan_step", id: s.id, index: s.index, total: s.total, title: s.title, phase: s.status === "done" ? "done" : "start" });

      const done = steps.filter((s) => s.status === "done").length;
      const blocked = steps.filter((s) => s.status === "blocked").length;
      const parts = [`${done}/${steps.length} done`];
      if (doing.length > 0) parts.push(`doing: ${doing.map((s) => s.title).join(", ")}`);
      if (blocked > 0) parts.push(`blocked: ${blocked}`);
      return { ok: true, content: parts.join("; ") };
    },
  };
}

// ---------------------------------------------------------------------------
// Spec alias adapters: expose the §8.5.1 tool schemas (terminal, text_editor,
// search, webpage_extract, browser, plan, message, map_reduce, suggestion,
// idle) and dispatch them to the matching Loam native tools.
// ---------------------------------------------------------------------------

const terminalSessions = new Map<string, string>(); // spec shellId -> Loam shell session id

async function execNative(registry: ToolRegistry, name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  return registry.exec(name, args, ctx);
}

function terminalTool(registry: ToolRegistry): Tool {
  return {
    name: "terminal",
    description: "Run or interact with a shell session in the task environment.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action", "shellId"],
      properties: {
        action: { enum: ["execute", "view", "wait", "send_input", "kill"] },
        shellId: { type: "string", pattern: "^[a-z0-9-]{1,40}$", description: "Reuse to keep state between commands." },
        command: { type: "string", description: "Required for execute." },
        cwd: { type: "string", description: "Absolute path; defaults to the workspace root." },
        input: { type: "string", description: "Required for send_input." },
        pressEnter: { type: "boolean", default: true },
        timeoutSec: { type: "integer", minimum: 1, maximum: 600, default: 120 },
        brief: { type: "string", maxLength: 120, description: "One-line step text for the UI." },
      },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const action = str(args, "action");
      const shellId = str(args, "shellId");
      if (!shellId) return { ok: false, content: "terminal requires shellId" };

      const cwd = str(args, "cwd") || undefined;
      const loamId = terminalSessions.get(shellId);

      if (action === "kill") {
        if (!loamId) return { ok: false, content: `no active session for shellId ${shellId}` };
        const res = await execNative(registry, "shell_kill", { id: loamId }, ctx);
        terminalSessions.delete(shellId);
        return res;
      }

      if (action === "execute") {
        const command = str(args, "command").trim();
        if (!command) return { ok: false, content: "terminal execute requires command" };
        let id = loamId;
        if (!id) {
          const start = await execNative(registry, "shell_start", { shell: "powershell", cwd }, ctx);
          if (!start.ok) return start;
          const m = /session (shell_[a-f0-9]+)/.exec(start.content);
          if (!m?.[1]) return { ok: false, content: "could not start terminal session" };
          id = m[1];
          terminalSessions.set(shellId, id);
        }
        const write = await execNative(registry, "shell_write", { id, input: command }, ctx);
        if (!write.ok) return write;
        await new Promise((r) => setTimeout(r, Math.min(num(args, "timeoutSec", 120), 600) * 1000));
        return execNative(registry, "shell_read", { id, waitMs: 0 }, ctx);
      }

      if (action === "send_input") {
        const input = str(args, "input");
        if (!input) return { ok: false, content: "terminal send_input requires input" };
        if (!loamId) return { ok: false, content: `no active session for shellId ${shellId}` };
        const line = bool(args, "pressEnter", true) ? `${input}\n` : input;
        const write = await execNative(registry, "shell_write", { id: loamId, input: line }, ctx);
        if (!write.ok) return write;
        return execNative(registry, "shell_read", { id: loamId, waitMs: 700 }, ctx);
      }

      if (action === "wait") {
        if (!loamId) return { ok: false, content: `no active session for shellId ${shellId}` };
        return execNative(registry, "shell_read", { id: loamId, waitMs: 700 }, ctx);
      }

      if (action === "view") {
        if (!loamId) return { ok: false, content: `no active session for shellId ${shellId}` };
        return execNative(registry, "shell_read", { id: loamId, waitMs: 0 }, ctx);
      }

      return { ok: false, content: `unknown terminal action ${action}` };
    },
  };
}

function textEditorTool(registry: ToolRegistry): Tool {
  return {
    name: "text_editor",
    description: "Read, create, overwrite, patch or search text files.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action", "path"],
      properties: {
        action: { enum: ["read", "write", "append", "str_replace", "find_in_file", "find_by_name"] },
        path: { type: "string" },
        content: { type: "string" },
        old_string: { type: "string", description: "Exact text to find (alias: oldStr)." },
        new_string: { type: "string", description: "Replacement text (alias: newStr)." },
        oldStr: { type: "string", description: "Alias for old_string." },
        newStr: { type: "string", description: "Alias for new_string." },
        replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a single unique match." },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
        regex: { type: "string" },
        glob: { type: "string" },
        brief: { type: "string", maxLength: 120 },
      },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const action = str(args, "action");
      const p = str(args, "path");
      if (!p) return { ok: false, content: "text_editor requires path" };

      switch (action) {
        case "read": {
          const startLine = num(args, "startLine", 1);
          const endLine = args.endLine === undefined ? undefined : num(args, "endLine", 1);
          const maxLines = endLine ? endLine - startLine + 1 : 400;
          return execNative(registry, "file_read", { path: p, startLine, maxLines }, ctx);
        }
        case "write":
          return execNative(registry, "file_write", { path: p, content: str(args, "content") }, ctx);
        case "append":
          return execNative(registry, "file_write", { path: p, content: str(args, "content"), append: true }, ctx);
        case "str_replace": {
          const oldString = strFirst(args, "old_string", "oldStr");
          const newString = strFirst(args, "new_string", "newStr");
          if (oldString === undefined) return { ok: false, content: "text_editor str_replace requires old_string (or oldStr)" };
          if (newString === undefined) return { ok: false, content: "text_editor str_replace requires new_string (or newStr)" };
          return execNative(
            registry,
            "file_edit",
            { path: p, old_string: oldString, new_string: newString, replace_all: bool(args, "replace_all", false) },
            ctx,
          );
        }
        case "find_in_file":
          return execNative(registry, "file_search", { pattern: str(args, "regex"), path: p }, ctx);
        case "find_by_name":
          return execNative(registry, "file_search", { pattern: str(args, "glob") || ".", path: p }, ctx);
        default:
          return { ok: false, content: `unknown text_editor action ${action}` };
      }
    },
  };
}

function searchTool(registry: ToolRegistry): Tool {
  return {
    name: "search",
    description: "Web search. Returns titles, links and snippets.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["queries"],
      properties: {
        queries: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 3 },
        type: { enum: ["web", "image", "news"], default: "web" },
        dateRange: { enum: ["all", "past_day", "past_week", "past_month", "past_year"], default: "all" },
        brief: { type: "string", maxLength: 120 },
      },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const queries = strs(args, "queries");
      if (queries.length === 0) return { ok: false, content: "search requires queries" };
      const combined = queries.join(" | ");
      const res = await execNative(registry, "web_search", { query: combined, limit: 10 }, ctx);
      if (!res.ok) return res;
      try {
        const parsed = JSON.parse(res.content);
        return {
          ok: true,
          content: JSON.stringify({
            queries,
            type: str(args, "type", "web"),
            dateRange: str(args, "dateRange", "all"),
            results: parsed.results ?? [],
          }, null, 2),
        };
      } catch {
        return res;
      }
    },
  };
}

function webpageExtractTool(registry: ToolRegistry): Tool {
  return {
    name: "webpage_extract",
    description: "Fetch a URL and return readable markdown.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", format: "uri" },
        maxChars: { type: "integer", minimum: 1000, maximum: 200_000, default: 40_000 },
        brief: { type: "string", maxLength: 120 },
      },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const url = str(args, "url");
      if (!url) return { ok: false, content: "webpage_extract requires url" };
      const maxChars = num(args, "maxChars", 40_000);
      const res = await execNative(registry, "web_fetch", { url, maxBytes: maxChars, raw: false }, ctx);
      if (!res.ok) return res;
      return {
        ok: true,
        content: JSON.stringify({ action: "extract", url, markdown: res.content, truncated: res.content.length >= maxChars }, null, 2),
      };
    },
  };
}

const browserTabs = new Map<string, string>(); // spec tabId -> Loam pageId
let tabCounter = 0;

function browserTool(registry: ToolRegistry): Tool {
  return {
    name: "browser",
    description: "Drive the in-app browser tab shown in the right panel.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { enum: ["open", "navigate", "observe", "click", "type", "press_key", "scroll", "select_option", "evaluate", "screenshot", "close"] },
        tabId: { type: "string" },
        url: { type: "string", format: "uri" },
        ref: { type: "string", description: "Element ref from the last observe()." },
        text: { type: "string" },
        key: { type: "string" },
        direction: { enum: ["up", "down"] },
        option: { type: "string" },
        script: { type: "string", description: "Only for evaluate; runs isolated from page credentials." },
        brief: { type: "string", maxLength: 120 },
      },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const action = str(args, "action");
      let pageId = str(args, "tabId") ? browserTabs.get(str(args, "tabId")) : undefined;

      if (action === "open") {
        const res = await execNative(registry, "browser_open", { url: str(args, "url") }, ctx);
        if (!res.ok) return res;
        const m = /pageId=(page_\d+)/.exec(res.content);
        if (!m?.[1]) return { ok: false, content: "could not create browser tab" };
        const tid = str(args, "tabId") || `tab_${++tabCounter}`;
        browserTabs.set(tid, m[1]);
        return { ok: true, content: res.content.replace(/pageId=page_\d+/, `tabId=${tid}`) };
      }

      if (!pageId) return { ok: false, content: "browser action requires an open tabId" };

      switch (action) {
        case "navigate":
          return execNative(registry, "browser_goto", { pageId, url: str(args, "url") }, ctx);
        case "observe":
          return execNative(registry, "browser_snapshot", { pageId }, ctx);
        case "click":
          return execNative(registry, "browser_click", { pageId, ref: str(args, "ref") }, ctx);
        case "type":
          return execNative(registry, "browser_type", { pageId, ref: str(args, "ref"), text: str(args, "text"), submit: false }, ctx);
        case "press_key":
          return execNative(registry, "browser_press", { pageId, key: str(args, "key") }, ctx);
        case "scroll": {
          const dir = str(args, "direction") === "up" ? "SCROLL_UP" : "SCROLL_DOWN";
          return execNative(registry, "browser_act", { pageId, op: dir }, ctx);
        }
        case "select_option":
          return execNative(registry, "browser_act", { pageId, op: "SELECT", text: str(args, "option") }, ctx);
        case "evaluate":
          return execNative(registry, "browser_eval", { pageId, expression: str(args, "script") }, ctx);
        case "screenshot":
          return execNative(registry, "browser_screenshot", { pageId, fullPage: false }, ctx);
        case "close": {
          const res = await execNative(registry, "browser_close", { pageId }, ctx);
          browserTabs.delete(str(args, "tabId"));
          return res;
        }
        default:
          return { ok: false, content: `unknown browser action ${action}` };
      }
    },
  };
}

export function messageTool(): Tool {
  return {
    name: "message",
    description: "Talk to the user. kind=notify does not block; kind=ask pauses the task until the user replies.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "text"],
      properties: {
        kind: { enum: ["notify", "ask", "result"] },
        text: { type: "string" },
        attachments: { type: "array", items: { type: "string" }, description: "Workspace paths to attach." },
        suggestTakeover: { enum: ["none", "browser"], default: "none" },
      },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const kind = str(args, "kind");
      const text = str(args, "text");
      ctx.emit({ type: "assistant_message", text });
      if (kind === "ask") {
        ctx.emit({ type: "approval_required", approvalId: `msg-${Date.now()}`, tool: "message", summary: text });
      }
      if (kind === "result") {
        ctx.emit({ type: "done", text, steps: 0, model: ctx.cfg.model });
      }
      return { ok: true, content: text };
    },
  };
}

function suggestionTool(): Tool {
  return {
    name: "suggestion",
    description: "Offer up to three follow-up prompts at the end of a turn.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["commands"],
      properties: {
        commands: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", maxLength: 160 } },
      },
    },
    async run(args: Record<string, unknown>): Promise<ToolResult> {
      const commands = strs(args, "commands");
      return {
        ok: true,
        content: JSON.stringify({ commands: commands.map((content) => ({ content, commandType: "followup_requirement" })) }, null, 2),
      };
    },
  };
}

function idleTool(): Tool {
  return {
    name: "idle",
    description: "Declare the task finished after the result message was sent.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async run(): Promise<ToolResult> {
      return { ok: true, content: "idle" };
    },
  };
}

export interface SpecAliasOptions {
  registry: ToolRegistry;
  ollama: OllamaClient;
  /** Subagent profile for map_reduce children. */
  defaultSubagent?: string;
}

/** Build the full set of §8.5.1 spec alias tools wired to Loam native tools. */
export function createSpecAliasTools(options: SpecAliasOptions): Tool[] {
  const { registry, ollama, defaultSubagent } = options;
  return [
    terminalTool(registry),
    textEditorTool(registry),
    searchTool(registry),
    webpageExtractTool(registry),
    browserTool(registry),
    planTool(),
    messageTool(),
    createMapReduceTool({ ollama, parentRegistry: registry, defaultSubagent }),
    suggestionTool(),
    idleTool(),
  ];
}

/** JSON schemas for the §8.5.1 tool catalogue, for validation or export. */
export function specToolSchemas(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const t of createSpecAliasTools({ registry: {} as ToolRegistry, ollama: {} as OllamaClient })) {
    out[t.name] = t.parameters;
  }
  return out;
}
