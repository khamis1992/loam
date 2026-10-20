/** socket.io chat channel: "message" event in both directions. */

import { Server, type Socket } from "socket.io";
import type { Server as HttpServer } from "node:http";
import type { AgentEvent, Emit } from "../agent/events.js";
import { cancelRunSignal } from "../server/runControl.js";
import { createTask, getTask, type Task } from "../server/db.js";
import type { RunTaskOptions } from "../server/http.js";
import { log } from "../log.js";
import { mapAgentEvent, shortUid, baseId } from "./events.js";
import type {
  ClientMessage,
  ServerEnvelope,
  UserMessage,
  ChatMessageEvent,
  SubmitWorkspaceDirectoryAccess,
  ResolveLocalExecutionApproval,
  TaskMode,
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

function mapTaskModeToLoam(mode?: string): string {
  const m = (mode ?? "").trim().toLowerCase();
  if (m === "lite" || m === "discuss") return "ask";
  if (m === "max" || m === "standard" || m === "cascade") return "build";
  return "build";
}

export function createChatSocket(deps: SocketDeps): Server {
  const { httpServer, store, runTask } = deps;

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
          const replay = store.eventsAfter(m.sessionId, m.lastMessageId);
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
              result: resolve.resolution === "approve" ? "approve" : "deny",
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
              const task = createTask(text, text.slice(0, 80), um.extData.projectId ?? null, null);
              taskId = task.id;
            }
            session.taskId = taskId;
            store.setTaskId(um.sessionId, taskId);
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
            const result = await runTask({
              prompt,
              emit,
              taskId,
              title: text.slice(0, 80),
              mode: mapTaskModeToLoam(um.extData.mode ?? um.taskMode),
              projectId: um.extData.projectId ?? null,
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

            // Mark the run as finished in the UI.
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
