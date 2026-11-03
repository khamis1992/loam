import type { RecallService } from "./service.js";

let current: RecallService | null = null;

export function setRecallService(service: RecallService | null): void {
  current = service;
}

export function getRecallService(): RecallService | null {
  return current;
}
