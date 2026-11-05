// Turns a finished visible recording into the same attachment frame the chat scan emits.
import path from "node:path";
import { setRecordingDelivery, type RecordingDelivery } from "../server/recorder/chatDelivery.js";
import { baseId } from "./events.js";
import type { ProtocolStore } from "./store.js";
import type { AttachmentEvent, ServerEnvelope } from "./types.js";

export interface RecordingSocket {
  to(sessionId: string): { emit(event: string, frame: ServerEnvelope): void };
}

export function recordingAttachment(item: RecordingDelivery, sessionId: string): ServerEnvelope<AttachmentEvent> | null {
  const rel = path.relative(path.resolve(item.workspace), path.resolve(item.videoPath)).split(path.sep).join("/");
  if (!rel || rel.startsWith("..") || rel.startsWith("/")) return null;
  const attachment: AttachmentEvent = {
    id: baseId(),
    type: "attachment",
    timestamp: Date.now(),
    name: path.basename(rel),
    path: rel,
    mime: "video/mp4",
    sizeBytes: item.bytes,
    taskId: item.taskId,
  };
  return {
    id: baseId(),
    type: "event",
    sessionId,
    timestamp: attachment.timestamp,
    event: attachment,
  };
}

export function attachRecordingDelivery(store: Pick<ProtocolStore, "getSessionByTaskId" | "appendEvent">, io: RecordingSocket): () => void {
  setRecordingDelivery((item) => {
    const session = store.getSessionByTaskId(item.taskId);
    if (!session) return;
    const frame = recordingAttachment(item, session.sessionId);
    if (!frame) return;
    store.appendEvent(session.sessionId, frame);
    io.to(session.sessionId).emit("message", frame);
  });
  return () => setRecordingDelivery(undefined);
}
