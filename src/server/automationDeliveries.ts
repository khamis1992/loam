import { database, transaction } from "./sqliteStore.js";

export interface AutomationDelivery {
  automationId: string;
  deliveryId: string;
  trigger: string;
  eventKind: string;
  receivedAt: string;
}

function ensureTable(): void {
  database().exec(`CREATE TABLE IF NOT EXISTS automation_deliveries (
    automation_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    trigger_name TEXT NOT NULL,
    event_kind TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (automation_id, delivery_id)
  );`);
}

export function claimAutomationDelivery(automationId: string, deliveryId: string, trigger: string, eventKind: string): boolean {
  ensureTable();
  return transaction(() => Number(database().prepare(
    "INSERT OR IGNORE INTO automation_deliveries (automation_id, delivery_id, trigger_name, event_kind, received_at) VALUES (?, ?, ?, ?, ?)",
  ).run(automationId, deliveryId, trigger, eventKind, new Date().toISOString()).changes)) > 0;
}

export function listAutomationDeliveries(automationId: string, limit = 50): AutomationDelivery[] {
  ensureTable();
  const rows = database().prepare(
    "SELECT automation_id, delivery_id, trigger_name, event_kind, received_at FROM automation_deliveries WHERE automation_id = ? ORDER BY received_at DESC LIMIT ?",
  ).all(automationId, Math.max(1, Math.min(200, Math.floor(limit)))) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    automationId: String(row.automation_id),
    deliveryId: String(row.delivery_id),
    trigger: String(row.trigger_name),
    eventKind: String(row.event_kind),
    receivedAt: String(row.received_at),
  }));
}
