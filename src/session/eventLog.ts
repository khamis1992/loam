import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config.js";

export interface SessionHeader {
  formatVersion: number;
  taskId: string;
  createdAt: string;
  cwd: string;
}

export interface LogEvent {
  seq: number;
  ts: number;
  type: string;
  data: unknown;
}

export interface Migration {
  from: number;
  to: number;
  migrateHeader: (h: SessionHeader) => SessionHeader;
  migrateEvent: (e: LogEvent) => LogEvent;
}

export interface Projection<S> {
  key: string;
  init: () => S;
  apply: (state: S, event: LogEvent) => S;
}

export class EventLog {
  private readonly dir: string;
  private readonly headerPath: string;
  private readonly logPath: string;
  private header?: SessionHeader;
  private seq = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(taskId: string) {
    this.dir = path.join(DATA_DIR, "sessions", taskId);
    this.headerPath = path.join(this.dir, "header.json");
    this.logPath = path.join(this.dir, "events.jsonl");
  }

  async init(taskId: string, cwd: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const h = await fs.readFile(this.headerPath, "utf8");
      this.header = JSON.parse(h);
      const content = await fs.readFile(this.logPath, "utf8");
      const lines = content.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const event: LogEvent = JSON.parse(line);
          this.seq = Math.max(this.seq, event.seq + 1);
        } catch {
          // Torn final line
        }
      }
    } catch {
      this.header = { formatVersion: 1, taskId, createdAt: new Date().toISOString(), cwd };
      await fs.writeFile(this.headerPath, JSON.stringify(this.header));
      await fs.writeFile(this.logPath, "");
    }
  }

  async append(type: string, data: unknown): Promise<void> {
    this.queue = this.queue.then(async () => {
      const event: LogEvent = { seq: this.seq++, ts: Date.now(), type, data };
      const line = JSON.stringify(event) + "\n";
      await fs.appendFile(this.logPath, line);
    });
    return this.queue;
  }
}

export function foldProjections<S>(events: LogEvent[], projection: Projection<S>): S {
  return events.reduce(projection.apply, projection.init());
}
