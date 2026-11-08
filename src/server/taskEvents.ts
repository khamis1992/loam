import { EventEmitter } from "node:events";

export interface TaskFinishedEvent {
  taskId: string;
  status: "done" | "error" | "cancelled" | "interrupted";
}

export const taskEvents = new EventEmitter();

export function emitTaskFinished(event: TaskFinishedEvent): void {
  taskEvents.emit("task:finished", event);
}
