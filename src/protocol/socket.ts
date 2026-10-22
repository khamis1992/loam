/** socket.io chat channel: "message" event in both directions. */

import fs from "node:fs";
import path from "node:path";
import { Server, type Socket } from "socket.io";
import type { Server as HttpServer } from "node:http";
import type { AgentEvent, Emit } from "../agent/events.js";
import { cancelRunSignal } from "../server/runControl.js";
import { createTask, setTaskWorkspace, type Task, type TaskMessage, type StepRecord } from "../server/db.js";
import { setThread, touchMessage } from "../server/agentThreads.js";
import { requireTaskWorkspace, taskPath } from "../server/taskWorkspace.js";
import { createWorktree } from "../server/worktrees.js";
import { isModelTier, resolveTierModel } from "../server/modelTiers.js";
import { loadConfig } from "../config.js";
import type { RunTaskOptions } from "../server/http.js";
import { log } from "../log.js";
import { mapAgentEvent, shortUid, baseId, createEventMapperState, makeBrief, mapToolName } from "./events.js";
import { getApproval, decideApproval } from "../server/approvals.js";
import { setTaskApprovalAuto, setTaskPermissionMode, createApprovalRule } from "../server/approvalRules.js";
import { isLocalPermissionMode } from "../policy/permissionModes.js";
import { resolveLoamMode, modeEventInfo } from "../modes/detect.js";
import { getLoamMode, normalizeModeId, LOAM_MODES } from "../modes/catalog.js";
import { appendTelemetry } from "../telemetry/store.js";
import { getBlob } from "./blobStore.js";
import type {
  ClientMessage,
  ServerEnvelope,
  UserMessage,
  ChatMessageEvent,
  SubmitWorkspaceDirectoryAccess,
  ResolveLocalExecutionApproval,
  TaskMode,
  ChatEvent,
  ServerAttachment,
  AttachmentEvent,
  ToolUsedEvent,
} from "./types.js";
import type { ProtocolStore } from "./store.js";
import { tokenToUserUid } from "./rpc.js";

// Re-export for callers.
export { Server } from "socket.io";

export interface SocketDeps {
  httpServer: HttpServer;
  store: ProtocolStore;
  runTask: (opts: RunTaskOptions) => Promise<{ taskId: string; text: string }>;
  getTask: (id: string) => Task | undefined;
  workspace: string;
}

function now(): string {
  return new Date().toISOString();
}

function mapTaskMode(mode?: string): TaskMode {
  if (mode === "lite") return "lite";
  if (mode === "max") return "max";
  if (mode === "discuss") return "discuss";
  if (mode === "cascade") return "cascade";
  return "standard";
}

function blobIdFromUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.pathname.startsWith("/blob/")) return u.pathname.slice(6);
  } catch {
    if (url.startsWith("/blob/")) return url.slice(6);
  }
  return undefined;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

/** Copy uploaded blobs into the task workspace and return a prompt block that
 *  points the agent at the files. */
function stageAttachments(
  attachments: ServerAttachment[],
  taskId: string,
  workspace: string,
): { files: { name: string; rel: string; abs: string }[]; promptBlock: string } {
  const root = requireTaskWorkspace(taskId, workspace);
  const files: { name: string; rel: string; abs: string }[] = [];
  for (const a of attachments.slice(0, 8)) {
    const id = blobIdFromUrl(a.url);
    if (!id) continue;
    const data = getBlob(id);
    if (!data || data.length === 0) continue;
    const name = sanitizeFilename(a.filename || a.id || "attachment");
    const rel = path.join("attachments", name);
    const abs = taskPath(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    files.push({ name, rel, abs });
  }
  if (files.length === 0) return { files, promptBlock: "" };
  const list = files.map((f) => `• "${f.name}" — already in the task workspace at \`${f.rel}\``).join("\n");
  const block = `【Attachments】The following files are attached to this task and are available in the workspace:\n${list}\nRead and analyze them as needed.`;
  return { files, promptBlock: block };
}

interface WorkspaceFileSnapshot {
  rel: string;
  size: number;
  mtimeMs: number;
}

const SKIP_WALK_DIRS = new Set([
  "node_modules",
  ".git",
  ".loam",
  "__pycache__",
  ".next",
  ".expo",
  ".screenshots",
  ".browser-recordings",
  ".browser-profile",
]);

/** Recursively list files under a task workspace, returning paths relative to the root. */
function snapshotWorkspaceFiles(root: string): WorkspaceFileSnapshot[] {
  const files: WorkspaceFileSnapshot[] = [];
  const walk = (dir: string) => {
    let items: fs.Dirent[] = [];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.name === "." || item.name === "..") continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (SKIP_WALK_DIRS.has(item.name)) continue;
        walk(full);
        continue;
      }
      try {
        const st = fs.statSync(full);
        files.push({ rel: path.relative(root, full).split(path.sep).join("/"), size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* ignore stat failures */
      }
    }
  };
  walk(root);
  return files;
}

function mimeFromExt(name: string): string {
  const ext = path.extname(name).toLowerCase();
  const map: Record<string, string> = {
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".ppt": "application/vnd.ms-powerpoint",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".csv": "text/csv",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
  };
  return map[ext] ?? "application/octet-stream";
}

/** True if the mapped tool category is terminal/shell. */
function isTerminalToolName(name: string): boolean {
  return name.startsWith("shell_") || name.startsWith("pty_");
}

function stepToAgentEvent(step: StepRecord): AgentEvent | undefined {
  const data = (step.data ?? {}) as Record<string, unknown>;
  const type = String(data.type ?? step.type ?? "");
  if (type === "plan") {
    const goal = String(data.goal ?? "");
    const steps = Array.isArray(data.steps)
      ? data.steps.map((s: Record<string, unknown>) => ({
          id: String(s.id ?? ""),
          title: String(s.title ?? ""),
          instruction: String(s.instruction ?? ""),
          successCriteria: String(s.successCriteria ?? ""),
        }))
      : [];
    return { type: "plan", goal, trivial: Boolean(data.trivial), steps, source: String(data.source ?? "fallback") as "model" | "fallback" };
  }
  if (type === "plan_step") {
    return {
      type: "plan_step",
      id: String(data.id ?? ""),
      index: Number(data.index ?? 0),
      total: Number(data.total ?? 1),
      title: String(data.title ?? ""),
      phase: String(data.phase ?? "start") as "start" | "done",
      summary: typeof data.summary === "string" ? data.summary : undefined,
    };
  }
  if (type === "tool_call") {
    return { type: "tool_call", name: String(data.name ?? ""), args: data.args ?? {} };
  }
  if (type === "tool_result") {
    return { type: "tool_result", name: String(data.name ?? ""), ok: Boolean(data.ok), summary: String(data.summary ?? ""), ms: typeof data.ms === "number" ? data.ms : undefined };
  }
  if (type === "assistant_message") {
    return { type: "assistant_message", text: String(data.text ?? "") };
  }
  if (type === "assistant_token") {
    return { type: "assistant_token", text: String(data.text ?? "") };
  }
  if (type === "done") {
    return { type: "done", text: String(data.text ?? ""), steps: Number(data.steps ?? 0), model: String(data.model ?? "") };
  }
  if (type === "error") {
    return { type: "error", message: String(data.message ?? "") };
  }
  if (type === "cancelled") {
    return { type: "cancelled" };
  }
  if (type === "task-status") {
    return { type: "task-status", status: String(data.status ?? "") };
  }
  if (type === "mode") {
    return { type: "mode", mode: String(data.mode ?? ""), label: String(data.label ?? ""), labelAr: String(data.labelAr ?? ""), reason: typeof data.reason === "string" ? data.reason : undefined };
  }
  if (type === "environment_issue") {
    // Rebuild the agent's environment-issue report so a persisted task replays
    // the same card instead of dropping it.
    return { type: "environment_issue", message: String(data.message ?? ""), ...(typeof data.details === "string" ? { details: data.details } : {}) };
  }
  return undefined;
}

function messageToChatEvent(msg: TaskMessage, timestamp: number, taskMode: TaskMode = "standard"): ChatMessageEvent {
  return {
    id: baseId(),
    type: "chat",
    timestamp,
    sender: msg.role === "user" ? "user" : "assistant",
    messageType: "text",
    content: msg.content,
    attachments: [],
    deliveryKind: msg.role === "user" ? "opening" : "result",
    taskMode,
  };
}

export function buildHistoryFromTask(task: Task, sessionId: string): ChatEvent[] {
  const state = createEventMapperState();
  const out: ChatEvent[] = [];
  // Persisted user/assistant messages give the conversation skeleton.
  for (const msg of task.messages ?? []) {
    const ts = Date.parse(msg.at) || Date.now();
    if (msg.role === "user") {
      out.push(messageToChatEvent(msg, ts, "standard"));
    } else if (msg.role === "assistant") {
      out.push(messageToChatEvent(msg, ts, "standard"));
    }
  }
  // Tool/plan events from steps enrich the timeline between messages.
  for (const step of task.steps ?? []) {
    const ev = stepToAgentEvent(step);
    if (!ev) continue;
    const mapped = mapAgentEvent(ev, state, sessionId);
    out.push(...mapped);
  }
  // Final status/clock so the page shows "Task completed" and "Worked for ...".
  const finalTs = Date.now();
  out.push({
    id: baseId(),
    type: "statusUpdate",
    timestamp: finalTs,
    agentStatus: task.status === "error" ? "error" : task.status === "cancelled" || task.status === "interrupted" ? "stopped" : "stopped",
    brief: "Agent finished working",
  });
  const started = Date.parse(task.createdAt) || finalTs;
  out.push({
    id: baseId(),
    type: "cascadeTaskClock",
    timestamp: finalTs,
    clock: {
      sessionId,
      taskId: task.id,
      startedAt: started,
      accumulatedMs: finalTs - started,
      phase: "closed",
      revision: 1,
    },
  });
  return out;
}

export function createChatSocket(deps: SocketDeps): Server {
  const { httpServer, store, runTask, getTask, workspace } = deps;

  const io = new Server(httpServer, {
    transports: ["websocket"],
    pingInterval: 25_000,
    pingTimeout: 60_000,
    cors: { origin: "*" },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token ?? socket.handshake.query?.token;
    if (typeof token === "string" && tokenToUserUid(token)) {
      socket.data.userUid = tokenToUserUid(token);
      socket.data.locale = String(socket.handshake.query?.locale ?? "en");
      return next();
    }
    next(new Error("unauthenticated"));
  });

  io.on("connection", (socket: Socket) => {
    log.info(`protocol socket connected: ${socket.id}`);

    socket.on("message", async (m: ClientMessage) => {
      try {
        if (m.type === "join_session") {
          await socket.join(m.sessionId);
          let replay = store.eventsAfter(m.sessionId, m.lastMessageId);
          // If the protocol store has no events for this session but the Loam task
          // has persisted messages/steps, synthesize the conversation history.
          if (replay.length === 0) {
            let session = store.getSession(m.sessionId) ?? store.getSessionByTaskId(m.sessionId);
            let task = session?.taskId ? getTask(session.taskId) : getTask(m.sessionId);
            // If we still have no task, try to find any Loam task whose id matches a
            // known short session id from the protocol store.
            if (!task && session?.sessionId) {
              task = getTask(session.sessionId);
            }
            if (task && (task.messages?.length || task.steps?.length)) {
              if (!session) {
                session = store.ensureSession(m.sessionId, task.id, task.title);
              } else if (!session.taskId) {
                store.setTaskId(m.sessionId, task.id);
              }
              const synthesized = buildHistoryFromTask(task, m.sessionId);
              replay = synthesized.map((event) => ({
                id: baseId(),
                type: "event" as const,
                sessionId: m.sessionId,
                timestamp: event.timestamp,
                event,
              }));
            }
          }
          const ts = Date.now();
          const frame: ServerEnvelope = {
            id: baseId(),
            type: "event",
            sessionId: m.sessionId,
            timestamp: ts,
            event: {
              id: baseId(),
              type: "eventsNotifyEventsAfter",
              timestamp: ts,
              events: replay.map((e) => e.event),
              eventId: m.lastMessageId ?? "",
              noPersistent: true,
            },
          };
          socket.emit("message", frame);
          return;
        }

        if (m.type === "leave_session") {
          await socket.leave(m.sessionId);
          return;
        }

        if (m.type === "stop_session") {
          const session = store.getSession(m.sessionId);
          if (session?.taskId) {
            cancelRunSignal(session.taskId);
            log.info(`protocol stop_session ${m.sessionId} -> task ${session.taskId}`);
          }
          return;
        }

        if (m.type === "submit_workspace_directory_access") {
          const submit = m as SubmitWorkspaceDirectoryAccess;
          const ts = Date.now();
          const result: ServerEnvelope = {
            id: baseId(),
            type: "event",
            sessionId: submit.sessionId,
            timestamp: ts,
            event: {
              id: baseId(),
              type: "workspaceDirectoryAccessResult",
              timestamp: ts,
              requestActionId: submit.requestActionId,
              success: submit.accept,
              cancelled: !submit.accept,
            },
          };
          store.appendEvent(submit.sessionId, result);
          io.to(submit.sessionId).emit("message", result);
          return;
        }

        if (m.type === "resolve_local_execution_approval") {
          const resolve = m as ResolveLocalExecutionApproval;
          const ts = Date.now();
          // MF4 (option 14): wire this path to the Loam approval gate — decide the
          // stored approval record; "always" additionally saves an allow rule for
          // the task's agent (global when the task has no agent).
          const approve = resolve.resolution !== "deny";
          const record = getApproval(resolve.requestId);
          if (record) decideApproval(resolve.requestId, approve ? "approve" : "deny");
          if (record && resolve.resolution === "always") {
            try {
              createApprovalRule({
                agentId: getTask(record.taskId)?.agentId ?? null,
                tool: record.tool,
                decision: "allow",
              });
            } catch (err) {
              log.warn(`approval rule from always-allow failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          const resolved: ServerEnvelope = {
            id: baseId(),
            type: "event",
            sessionId: resolve.sessionId,
            timestamp: ts,
            event: {
              id: baseId(),
              type: "localExecutionApprovalResolved",
              timestamp: ts,
              requestId: resolve.requestId,
              reviewer: "user",
              result: approve ? "approve" : "deny",
            },
          };
          store.appendEvent(resolve.sessionId, resolved);
          io.to(resolve.sessionId).emit("message", resolved);
          return;
        }

        if (m.type === "user_message") {
          const um = m as UserMessage;
          const text = um.contents.map((c) => c.value).join("").trim();
          const session = store.ensureSession(um.sessionId, "", text.slice(0, 80));

          let taskId = session.taskId;
          if (!taskId || !getTask(taskId)) {
            if (getTask(um.sessionId)) {
              taskId = um.sessionId;
            } else {
              const task = createTask(text, text.slice(0, 80), um.extData.projectId ?? null, um.extData.agentId ?? null);
              taskId = task.id;
            }
            session.taskId = taskId;
            store.setTaskId(um.sessionId, taskId);
            // Option 17: bind the composer folder (or a fresh git worktree under it) to the new task.
            const composerFolder = (um.extData.desktopBinding?.folderPath ?? "").trim();
            if (composerFolder && fs.existsSync(composerFolder)) {
              try {
                if (um.extData.worktreeEnabled) {
                  const wt = await createWorktree(composerFolder, taskId);
                  setTaskWorkspace(taskId, "ok" in wt ? wt.path : composerFolder);
                } else {
                  setTaskWorkspace(taskId, composerFolder);
                }
              } catch (err) {
                log.warn(`composer folder bind failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }

          // Persist the agent -> thread mapping so unread state survives restarts.
          if (um.extData.agentId) {
            setThread(um.extData.agentId, taskId);
            touchMessage(um.extData.agentId);
          }

          // MF4: "Approve for me" chip — the composer sends its current toggle with
          // every message, so a brand-new session lands on the right task too.
          if (typeof um.extData.approveForMe === "boolean") {
            setTaskApprovalAuto(taskId, um.extData.approveForMe);
          }

          // C13: a message can start (or continue) the task in the read-only
          // `plan` permission mode; the run gate then refuses every mutating tool
          // call until `plan_exit` is approved and switches the task to acceptEdits.
          if (isLocalPermissionMode(um.extData.localPermissionMode)) {
            setTaskPermissionMode(taskId, um.extData.localPermissionMode);
          }

          // Forward the UI locale to Loam. Because Loam has no per-request locale
          // channel, append a short locale marker to the user prompt.
          const locale = String((socket as unknown as { data: { locale?: string } }).data.locale ?? "en");
          let prompt = text;
          if (locale.startsWith("en")) {
            prompt = `${text}\n\n(Locale: en — reply in English.)`;
          } else if (locale.startsWith("ar")) {
            prompt = `${text}\n\n(Locale: ar — رد بالعربية.)`;
          }

          // Stage uploaded attachments into the task workspace so the agent can read them.
          const serverAttachments = (um.attachments ?? []).map((a) => ({
            id: a.id,
            filename: a.filename,
            type: a.type,
            url: a.url,
            contentType: a.contentType,
            contentLength: a.fileMetaData?.uploadProgress ? Number(a.fileMetaData.uploadProgress) : 0,
          }));
          const { promptBlock } = stageAttachments(serverAttachments, taskId, workspace);
          if (promptBlock) {
            prompt = `${prompt}\n\n${promptBlock}`;
          }

          // Snapshot the workspace after staging user uploads so we can diff
          // the files produced by this run at the end.
          const taskRoot = requireTaskWorkspace(taskId, workspace);
          const beforeFiles = snapshotWorkspaceFiles(taskRoot);

          // Echo user message.
          const userChat: ChatMessageEvent = {
            id: baseId(),
            type: "chat",
            timestamp: Date.now(),
            sender: "user",
            messageType: "text",
            content: text,
            contents: um.contents,
            attachments: (um.attachments ?? []).map((a) => ({
              ...a,
              contentLength: a.fileMetaData?.uploadProgress ? Number(a.fileMetaData.uploadProgress) : 0,
            })),
            deliveryKind: "opening",
            taskMode: um.taskMode,
          };
          const userFrame: ServerEnvelope = {
            id: baseId(),
            type: "event",
            sessionId: um.sessionId,
            timestamp: userChat.timestamp,
            event: userChat,
          };
          store.appendEvent(um.sessionId, userFrame);
          io.to(um.sessionId).emit("message", userFrame);

          // Run the Loam task and stream mapped events.
          let assistantResultEmitted = false;
          const emit: Emit = (event: AgentEvent) => {
            for (const chatEvent of mapAgentEvent(event, session.mapperState, um.sessionId)) {
              const frame: ServerEnvelope = {
                id: baseId(),
                type: "event",
                sessionId: um.sessionId,
                timestamp: Date.now(),
                event: chatEvent,
              };
              if (
                chatEvent.type === "chat" &&
                chatEvent.sender === "assistant" &&
                chatEvent.deliveryKind === "result"
              ) {
                assistantResultEmitted = true;
              }
              store.appendEvent(um.sessionId, frame);
              io.to(um.sessionId).emit("message", frame);
            }
          };

          try {
            const resolvedMode = resolveLoamMode(um, prompt);

            const explicitRaw = (um.extData.loamMode ?? "").trim();
            const explicitValid = explicitRaw && LOAM_MODES.some((m) => m.id === normalizeModeId(explicitRaw));
            const modeDef = getLoamMode(resolvedMode);
            const dedicatedToolPattern = /^(office_|loam_document|loam_studio|loam_creative|loam_canvas|loam_dataset|data_chart|pentest_|security_|browser_|web_search)$/;
            appendTelemetry({
              at: now(),
              kind: "mode",
              taskId,
              mode: resolvedMode,
              toolset: modeDef.tools,
              dedicatedTools: modeDef.tools.filter((name) => dedicatedToolPattern.test(name)),
              source: explicitValid ? "explicit" : "detected",
              // TelemetryRecord keeps task/eval-case fields required; fill with
              // neutral values for mode-only rows so existing consumers compile.
              model: "",
              status: "done",
              steps: 0,
              durationMs: 0,
              usage: { promptTokens: 0, completionTokens: 0 },
              toolCalls: [],
              promptHash: "",
              promptChars: prompt.length,
            });

            emit({ type: "mode", ...modeEventInfo(resolvedMode) });

            // Option 18: the composer's model tier resolves to a concrete model id.
            const tierModel = isModelTier(um.extData.modelTier) ? resolveTierModel(loadConfig(), um.extData.modelTier).model : undefined;

            const result = await runTask({
              prompt,
              emit,
              taskId,
              title: text.slice(0, 80),
              mode: resolvedMode,
              projectId: um.extData.projectId ?? null,
              agentId: um.extData.agentId ?? undefined,
              workMode: um.extData.workMode ?? undefined,
              ...(tierModel ? { model: tierModel } : {}),
            });

            // Final assistant result if the agent stream did not already emit one.
            if (result.text && !assistantResultEmitted) {
              const finalChat: ChatMessageEvent = {
                id: baseId(),
                type: "chat",
                timestamp: Date.now(),
                sender: "assistant",
                messageType: "text",
                content: result.text,
                attachments: [],
                deliveryKind: "result",
                taskMode: um.taskMode,
              };
              const finalFrame: ServerEnvelope = {
                id: baseId(),
                type: "event",
                sessionId: um.sessionId,
                timestamp: finalChat.timestamp,
                event: finalChat,
              };
              store.appendEvent(um.sessionId, finalFrame);
              io.to(um.sessionId).emit("message", finalFrame);
            }

            // Emit attachment events for files produced during this run.
            const afterFiles = snapshotWorkspaceFiles(taskRoot);
            const beforeSet = new Set(beforeFiles.map((f) => f.rel));
            for (const file of afterFiles) {
              if (beforeSet.has(file.rel)) continue;
              const attachment: AttachmentEvent = {
                id: baseId(),
                type: "attachment",
                timestamp: Date.now(),
                name: path.basename(file.rel),
                path: file.rel,
                mime: mimeFromExt(file.rel),
                sizeBytes: file.size,
                taskId,
              };
              const frame: ServerEnvelope = {
                id: baseId(),
                type: "event",
                sessionId: um.sessionId,
                timestamp: attachment.timestamp,
                event: attachment,
              };
              store.appendEvent(um.sessionId, frame);
              io.to(um.sessionId).emit("message", frame);
            }

            // Add a terminal "run complete" marker if no terminal tool was used.
            const hasTerminal =
              Array.from(session.mapperState.runningTool).some(isTerminalToolName) ||
              Array.from(session.mapperState.toolActionIds.keys()).some((key) => isTerminalToolName(key.split(":")[0] ?? ""));
            if (!hasTerminal) {
              const marker: ToolUsedEvent = {
                id: baseId(),
                type: "toolUsed",
                timestamp: Date.now(),
                tool: "terminal",
                actionId: baseId(),
                status: "success",
                brief: "Run complete",
              };
              const frame: ServerEnvelope = {
                id: baseId(),
                type: "event",
                sessionId: um.sessionId,
                timestamp: marker.timestamp,
                event: marker,
              };
              store.appendEvent(um.sessionId, frame);
              io.to(um.sessionId).emit("message", frame);
            }

            // Mark the run as finished in the UI.
            // Finalize any tool rows still running so the timeline shows green checks.
            for (const name of Array.from(session.mapperState.runningTool)) {
              const actionId = session.mapperState.toolActionIds.get(`${name}:0`) ?? baseId();
              const brief = makeBrief(name, {});
              const toolUsed: ServerEnvelope = {
                id: baseId(),
                type: "event",
                sessionId: um.sessionId,
                timestamp: Date.now(),
                event: {
                  id: baseId(),
                  type: "toolUsed",
                  timestamp: Date.now(),
                  tool: mapToolName(name),
                  actionId,
                  status: "success",
                  brief: brief === name ? "" : brief,
                },
              };
              store.appendEvent(um.sessionId, toolUsed);
              io.to(um.sessionId).emit("message", toolUsed);
            }
            session.mapperState.runningTool.clear();

            const stopStatus: ServerEnvelope = {
              id: baseId(),
              type: "event",
              sessionId: um.sessionId,
              timestamp: Date.now(),
              event: {
                id: baseId(),
                type: "statusUpdate",
                timestamp: Date.now(),
                agentStatus: "stopped",
                brief: "Agent finished working",
              },
            };
            store.appendEvent(um.sessionId, stopStatus);
            io.to(um.sessionId).emit("message", stopStatus);

            // Cascade clock for "Worked for Ns".
            const started = session.createdAt;
            const clockEvent: ServerEnvelope = {
              id: baseId(),
              type: "event",
              sessionId: um.sessionId,
              timestamp: Date.now(),
              event: {
                id: baseId(),
                type: "cascadeTaskClock",
                timestamp: Date.now(),
                clock: {
                  sessionId: um.sessionId,
                  taskId: result.taskId,
                  startedAt: started,
                  accumulatedMs: Date.now() - started,
                  phase: "closed",
                  revision: 1,
                },
              },
            };
            store.appendEvent(um.sessionId, clockEvent);
            io.to(um.sessionId).emit("message", clockEvent);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.warn(`protocol runTask ${taskId}: ${message}`);
            emit({ type: "error", message });
          }
          return;
        }

        log.warn(`protocol unknown client message type: ${(m as { type?: string }).type}`);
      } catch (err) {
        log.error(`protocol socket message error: ${err instanceof Error ? err.message : String(err)}`);
        socket.emit("message", {
          id: baseId(),
          type: "event",
          sessionId: (m as { sessionId?: string }).sessionId ?? "unknown",
          timestamp: Date.now(),
          event: { id: baseId(), type: "error", timestamp: Date.now(), message: "internal error" },
        });
      }
    });

    socket.on("disconnect", () => {
      log.info(`protocol socket disconnected: ${socket.id}`);
    });
  });

  return io;
}
