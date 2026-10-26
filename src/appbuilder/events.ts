// src/appbuilder/events.ts
import { randomUUID } from "node:crypto";
import { append } from "../protocol/eventLog.js";
import type { ChatEvent } from "../protocol/types.js";

export function projectSession(projectId: string): string {
  return `app:${projectId}`;
}

type Payload<T extends ChatEvent["type"]> = Omit<Extract<ChatEvent, { type: T }>, "id" | "type" | "timestamp">;

export function emitProjectEvent<T extends ChatEvent["type"]>(projectId: string, type: T, payload: Payload<T>, idempotencyKey?: string): void {
  const event = { id: randomUUID(), type, timestamp: Date.now(), ...payload } as unknown as ChatEvent;
  append(projectSession(projectId), "chat_event", event, idempotencyKey ? { idempotencyKey } : {});
}
