import type { AgentEvent } from "../agent/events.js";
import type {
  ChatEvent,
  ChatDeltaEvent,
  ChatMessageEvent,
  StatusUpdateEvent,
  ToolUsedEvent,
  ToolDetail,
  PlanUpdateEvent,
  NewPlanStepEvent,
  TodoUpdateEvent,
  LiveStatusEvent,
  ModeEvent,
  UserStopEvent,
  ToolName,
  ToolStatus,
  LocalExecutionApprovalRequested,
  FolderAccessRequestEvent,
  PlanApprovalRequestedEvent,
  CacheUsageEvent,
} from "./types.js";

const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function shortUid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(22));
  return Array.from(bytes, (b) => alphabet[b % 62]).join("");
}

export function baseId(): string {
  return shortUid();
}

/** Map a Loam tool name to the Manus-style tool category used by the client. */
export function mapToolName(name: string): ToolName {
  if (name.startsWith("shell_") || name.startsWith("pty_")) return "terminal";
  if (name === "file_read" || name === "file_write" || name === "file_edit" || name === "file_search" || name === "file_list") return "text_editor";
  if (name === "web_search") return "search";
  if (name === "web_fetch") return "webpage_extract";
  if (name.startsWith("browser_")) return "browser";
  if (name.startsWith("mcp_")) return "mcp";
  return name as ToolName;
}

function makeActionId(name: string): string {
  return `call_${baseId().slice(0, 16)}_${name.replace(/\W/g, "").slice(0, 8)}`;
}

function buildTerminalDetail(name: string, args: unknown, result?: { ok: boolean; summary: string }): ToolDetail {
  const a = (args as Record<string, unknown>) ?? {};
  const command = typeof a.command === "string" ? a.command : typeof a.input === "string" ? a.input : String(a ?? "");
  return {
    terminal: {
      shellId: typeof a.session === "string" ? a.session : "default",
      action: "execute",
      command,
      output: result ? [result.summary] : undefined,
      outputType: "append",
      finished: result !== undefined,
    },
  };
}

function buildTextEditorDetail(name: string, args: unknown, result?: { ok: boolean; summary: string }): ToolDetail {
  const a = (args as Record<string, unknown>) ?? {};
  const action: "read" | "write" | "update" = name === "file_write" ? "write" : name === "file_edit" ? "update" : "read";
  return {
    textEditor: {
      action,
      path: String(a.path ?? ""),
      content: typeof a.content === "string" ? a.content : undefined,
      oldContent: typeof a.find === "string" ? a.find : undefined,
    },
  };
}

function buildSearchDetail(args: unknown, result?: { ok: boolean; summary: string }): ToolDetail {
  const a = (args as Record<string, unknown>) ?? {};
  const queries: string[] = Array.isArray(a.query) ? a.query.map(String) : typeof a.query === "string" ? [a.query] : [];
  let results: { title: string; link: string; snippet: string; favicon?: string }[] = [];
  if (result?.summary) {
    try {
      const parsed = JSON.parse(result.summary);
      if (Array.isArray(parsed.results)) {
        results = parsed.results.map((r: Record<string, string>) => ({
          title: String(r.title ?? ""),
          link: String(r.url ?? r.link ?? ""),
          snippet: String(r.snippet ?? ""),
        }));
      }
    } catch {
      results = [{ title: "Search result", link: "", snippet: result.summary }];
    }
  }
  return { search: { queries, results } };
}

function buildWebpageExtractDetail(args: unknown, result?: { ok: boolean; summary: string }): ToolDetail {
  const a = (args as Record<string, unknown>) ?? {};
  return {
    webpageExtract: {
      action: "extract",
      url: String(a.url ?? ""),
      markdown: result?.summary ?? "",
      truncated: false,
    },
  };
}

function buildToolDetail(name: string, args: unknown, result?: { ok: boolean; summary: string }): ToolDetail | undefined {
  const mapped = mapToolName(name);
  if (mapped === "terminal") return buildTerminalDetail(name, args, result);
  if (mapped === "text_editor") return buildTextEditorDetail(name, args, result);
  if (mapped === "search") return buildSearchDetail(args, result);
  if (mapped === "webpage_extract") return buildWebpageExtractDetail(args, result);
  return undefined;
}

export function makeBrief(name: string, args: unknown): string {
  const a = (args as Record<string, unknown>) ?? {};
  if (name.startsWith("shell_") || name.startsWith("pty_")) {
    return typeof a.command === "string" ? a.command.slice(0, 60) : "";
  }
  if (name === "file_read" || name === "file_write" || name === "file_edit") {
    return typeof a.path === "string" ? a.path : "";
  }
  if (name === "web_search") {
    if (typeof a.query === "string") return a.query;
    if (Array.isArray(a.query)) return a.query.map(String).join(", ");
    return "";
  }
  if (name === "web_fetch") {
    return typeof a.url === "string" ? a.url : "";
  }
  if (name.startsWith("browser_")) {
    return typeof a.url === "string" ? a.url : typeof a.target === "string" ? a.target : "";
  }
  return "";
}

export interface MappedEvents {
  events: ChatEvent[];
  // Track tool calls in-flight so tool_result can update the same actionId/status.
  toolActionIds?: Map<string, string>;
}

/** Per-session mutable state used while mapping a live stream. */
export interface EventMapperState {
  toolActionIds: Map<string, string>;
  lastPlanStepId?: string;
  runningTool: Set<string>;
  assistantBubbleTarget?: string;
  /** Sequence number for synthetic ids when rebuilding history from a DB task. */
  seq?: number;
}

export function createEventMapperState(): EventMapperState {
  return { toolActionIds: new Map(), runningTool: new Set(), assistantBubbleTarget: undefined, seq: 0 };
}

/** Map one Loam AgentEvent to zero or more Manus ChatEvents.
 *  state is mutated to keep actionId continuity between tool_call and tool_result. */
export function mapAgentEvent(event: AgentEvent, state: EventMapperState, sessionId: string): ChatEvent[] {
  const ts = Date.now();
  const out: ChatEvent[] = [];

  // When rebuilding history from a DB task, use deterministic synthetic ids.
  const synthId = () => {
    if (state.seq !== undefined) {
      state.seq += 1;
      return `hist_${state.seq.toString().padStart(6, "0")}`;
    }
    return baseId();
  };

  switch (event.type) {
    case "assistant_token": {
      if (!state.assistantBubbleTarget) state.assistantBubbleTarget = baseId();
      const delta: ChatDeltaEvent = {
        id: baseId(),
        type: "chatDelta",
        timestamp: ts,
        delta: { content: event.text },
        finished: false,
        sender: "assistant",
        taskMode: "standard",
        qualityMode: "standard",
        deliveryKind: "provisional",
        rollback: false,
        targetEventId: state.assistantBubbleTarget,
        noPersistent: true,
      };
      out.push(delta);
      break;
    }

    case "assistant_message": {
      if (!state.assistantBubbleTarget) state.assistantBubbleTarget = synthId();
      const chat: ChatMessageEvent = {
        id: state.assistantBubbleTarget,
        type: "chat",
        timestamp: ts,
        sender: "assistant",
        messageType: "text",
        content: event.text,
        attachments: [],
        deliveryKind: "result",
        taskMode: "standard",
      };
      state.assistantBubbleTarget = undefined;
      out.push(chat);
      break;
    }

    case "tool_call": {
      const callSeq = state.seq ?? 0;
      const existingActionId = state.toolActionIds.get(`${event.name}:${callSeq}`);
      const actionId = existingActionId ?? makeActionId(event.name);
      state.toolActionIds.set(`${event.name}:${callSeq}`, actionId);
      state.runningTool.add(event.name);
      const brief = makeBrief(event.name, event.args);
      const argumentsFinished: ToolUsedEvent = {
        id: baseId(),
        type: "toolUsed",
        timestamp: ts,
        tool: mapToolName(event.name),
        actionId,
        status: "argumentsFinished",
        brief,
        planStepId: state.lastPlanStepId,
        argumentsDetail: buildToolDetail(event.name, event.args),
      };
      const running: ToolUsedEvent = {
        id: baseId(),
        type: "toolUsed",
        timestamp: ts,
        tool: mapToolName(event.name),
        actionId,
        status: "running",
        brief,
        planStepId: state.lastPlanStepId,
        noPersistent: true,
      };
      out.push(argumentsFinished, running);
      break;
    }

    case "tool_result": {
      const actionId = state.toolActionIds.get(`${event.name}:${state.seq ?? 0}`) ?? state.toolActionIds.get(event.name) ?? makeActionId(event.name);
      state.runningTool.delete(event.name);
      const status: ToolStatus = event.ok ? "success" : "error";
      const detail = buildToolDetail(event.name, undefined, { ok: event.ok, summary: event.summary });
      const toolUsed: ToolUsedEvent = {
        id: baseId(),
        type: "toolUsed",
        timestamp: ts,
        tool: mapToolName(event.name),
        actionId,
        status,
        brief: makeBrief(event.name, {}),
        description: event.summary,
        planStepId: state.lastPlanStepId,
        detail,
      };
      out.push(toolUsed);
      break;
    }

    case "plan": {
      const planUpdate: PlanUpdateEvent = {
        id: baseId(),
        type: "planUpdate",
        timestamp: ts,
        tasks: event.steps.map((s, i) => ({
          title: s.title,
          status: s.status ?? (i === 0 ? "doing" : "done"),
          startedAt: ts,
        })),
      };
      out.push(planUpdate);
      break;
    }

    case "todo": {
      const todoUpdate: TodoUpdateEvent = {
        id: baseId(),
        type: "todoUpdate",
        timestamp: ts,
        todos: event.todos.map((todo) => ({ id: todo.id, content: todo.content, status: todo.status })),
      };
      out.push(todoUpdate);
      break;
    }

    case "plan_step": {
      if (event.phase === "start") {
        state.lastPlanStepId = event.id;
        const step: NewPlanStepEvent = {
          id: baseId(),
          type: "newPlanStep",
          timestamp: ts,
          stepId: event.id,
          title: event.title,
        };
        out.push(step);
      }
      break;
    }

    case "task-status": {
      const statusText = String(event.status).toLowerCase();
      // "queued" is a transient state; the UI should stay as-is until "running" arrives.
      if (statusText !== "running" && statusText !== "waiting" && statusText !== "error") {
        break;
      }
      const agentStatus: StatusUpdateEvent["agentStatus"] =
        statusText === "running" ? "running" : statusText === "waiting" ? "waiting" : "error";
      const brief = agentStatus === "running" ? "Agent is running" : `Agent ${agentStatus}`;
      const statusUpdate: StatusUpdateEvent = {
        id: baseId(),
        type: "statusUpdate",
        timestamp: ts,
        agentStatus,
        brief,
        noRender: agentStatus === "running",
      };
      out.push(statusUpdate);
      if (agentStatus === "running") {
        const live: LiveStatusEvent = {
          id: baseId(),
          type: "liveStatus",
          timestamp: ts,
          text: "Thinking",
          noPersistent: true,
        };
        out.push(live);
      }
      break;
    }

    case "done": {
      // Final assistant result will come through assistant_message or the runTask return.
      // Emit a final chatDelta finished marker and a stopped status.
      if (state.assistantBubbleTarget) {
        out.push({
          id: baseId(),
          type: "chatDelta",
          timestamp: ts,
          delta: { content: "" },
          finished: true,
          sender: "assistant",
          taskMode: "standard",
          qualityMode: "standard",
          deliveryKind: "result",
          rollback: false,
          targetEventId: state.assistantBubbleTarget,
          noPersistent: true,
        });
      }
      break;
    }

    case "error": {
      const cancelled = event.message.includes("cancelled") || event.message.includes("أُوقفت");
      if (cancelled) {
        const userStop: UserStopEvent = { id: baseId(), type: "userStop", timestamp: ts };
        out.push(userStop);
      }
      const status: StatusUpdateEvent = {
        id: baseId(),
        type: "statusUpdate",
        timestamp: ts,
        agentStatus: cancelled ? "stopped" : "error",
        brief: cancelled ? "Task stopped at your request" : event.message,
      };
      out.push(status);
      if (!cancelled) {
        const chat: ChatMessageEvent = {
          id: baseId(),
          type: "chat",
          timestamp: ts,
          sender: "assistant",
          messageType: "text",
          content: event.message,
          attachments: [],
          deliveryKind: "result",
          taskMode: "standard",
        };
        out.push(chat);
      }
      break;
    }

    case "cancelled": {
      const userStop: UserStopEvent = { id: baseId(), type: "userStop", timestamp: ts };
      const status: StatusUpdateEvent = {
        id: baseId(),
        type: "statusUpdate",
        timestamp: ts,
        agentStatus: "stopped",
        brief: "Agent has stopped",
      };
      out.push(userStop, status);
      break;
    }

    case "approval_required": {
      const approval: LocalExecutionApprovalRequested = {
        id: baseId(),
        type: "localExecutionApprovalRequested",
        timestamp: ts,
        requestId: event.approvalId,
        reviewer: "user",
        actionType: "terminal",
        summary: event.summary,
        detail: {
          kind: "terminal",
          command: event.tool,
          justification: event.summary,
        },
      };
      out.push(approval);
      break;
    }

    case "plan_approval_required": {
      const plan: PlanApprovalRequestedEvent = {
        id: baseId(),
        type: "planApprovalRequested",
        timestamp: ts,
        requestId: event.planApprovalId,
        taskId: event.taskId,
        summary: event.summary,
        steps: event.steps,
        filesToEdit: event.filesToEdit,
        trivial: event.trivial,
      };
      out.push(plan);
      break;
    }

    case "mode": {
      const modeEv: ModeEvent = {
        id: baseId(),
        type: "mode",
        timestamp: ts,
        mode: event.mode,
        label: event.label,
        labelAr: event.labelAr,
        reason: event.reason,
      };
      out.push(modeEv);
      break;
    }

    case "cache_usage": {
      // Prompt-cache accounting is a persistent chat row (never replayed as a
      // miss when telemetry is absent), so it stays in the session history.
      const cacheUsage: CacheUsageEvent = {
        id: baseId(),
        type: "cache_usage",
        timestamp: ts,
        provider: event.provider,
        model: event.model,
        promptTokens: event.promptTokens,
        cachedTokens: event.cachedTokens,
        ...(event.miss ? { miss: { ...event.miss } } : {}),
      };
      out.push(cacheUsage);
      break;
    }

    // State-only Loam events that do not have a chat-row rendering equivalent.
    case "task":
    case "step":
    case "workmode":
    case "phase":
    case "critique":
    case "revise":
    case "replan":
    case "verify":
    case "verification_progress":
    case "permission_mode_changed":
      break;
  }

  return out;
}
