// A recording that finishes after the agent run still belongs to that task's chat.
import path from "node:path";

export interface RecordingDelivery {
  taskId: string;
  workspace: string;
  videoPath: string;
  bytes: number;
}

type Handler = (item: RecordingDelivery) => void;
let handler: Handler | undefined;

export function setRecordingDelivery(next: Handler | undefined): void {
  handler = next;
}

export function deliverRecording(item: RecordingDelivery): void {
  if (!item.taskId || !handler) return;
  const root = path.resolve(item.workspace);
  const file = path.resolve(item.videoPath);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (file !== root && !file.startsWith(prefix)) return;
  if (path.extname(file).toLowerCase() !== ".mp4") return;
  handler(item);
}
