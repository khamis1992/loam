/**
 * Scanner telemetry (ALL_SERVICES §4.5/§18): one bounded, in-process record of every
 * scan invocation — duration, finding counts, engine versions, budget hits — with a
 * ring-buffer cap and a JSON snapshot for the observability surface. Pure data; no
 * target content is retained (rule ids and counts only).
 */
import fs from "node:fs";
import path from "node:path";

export interface ScanTelemetryEntry {
  at: string;
  scan: string;
  target: string;
  tenantId?: string;
  status?: "covered" | "partial" | "error" | "unavailable";
  durationMs: number;
  findings: number;
  bySeverity?: Record<string, number>;
  engines?: Array<{ tool: string; status: string; version?: string }>;
  budgetHit?: string;
}

const MAX_ENTRIES = 500;

export class ScanTelemetry {
  private readonly ring: ScanTelemetryEntry[] = [];

  constructor(private readonly snapshotFile?: string) {
    if (snapshotFile) {
      try {
        const saved = JSON.parse(fs.readFileSync(snapshotFile, "utf8")) as ScanTelemetryEntry[];
        if (Array.isArray(saved)) this.ring.push(...saved.slice(-MAX_ENTRIES));
      } catch { /* missing or invalid telemetry is not security evidence */ }
    }
  }

  record(e: ScanTelemetryEntry): void {
    this.ring.push(e);
    if (this.ring.length > MAX_ENTRIES) this.ring.splice(0, this.ring.length - MAX_ENTRIES);
    if (this.snapshotFile) {
      fs.mkdirSync(path.dirname(this.snapshotFile), { recursive: true });
      const tmp = `${this.snapshotFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.ring));
      fs.renameSync(tmp, this.snapshotFile);
    }
  }

  entries(): readonly ScanTelemetryEntry[] { return this.ring; }

  snapshot(): {
    total: number;
    last24h: number;
    slowest: Array<{ scan: string; target: string; durationMs: number }>;
    budgetHits: number;
    engineHealth: Record<string, { ok: number; degraded: number }>;
    tenantHealth: Record<string, { covered: number; degraded: number }>;
  } {
    const dayAgo = Date.now() - 86_400_000;
    const engineHealth: Record<string, { ok: number; degraded: number }> = {};
    const tenantHealth: Record<string, { covered: number; degraded: number }> = {};
    let budgetHits = 0;
    for (const e of this.ring) {
      if (e.budgetHit) budgetHits++;
      for (const eng of e.engines ?? []) {
        const h = (engineHealth[eng.tool] ??= { ok: 0, degraded: 0 });
        if (eng.status === "ok") h.ok++; else h.degraded++;
      }
      if (e.tenantId) {
        const h = (tenantHealth[e.tenantId] ??= { covered: 0, degraded: 0 });
        if (e.status === "covered") h.covered++; else h.degraded++;
      }
    }
    return {
      total: this.ring.length,
      last24h: this.ring.filter((e) => new Date(e.at).getTime() >= dayAgo).length,
      slowest: [...this.ring].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5)
        .map((e) => ({ scan: e.scan, target: e.target, durationMs: e.durationMs })),
      budgetHits,
      engineHealth,
      tenantHealth,
    };
  }
}

export const scanTelemetry = new ScanTelemetry(process.env.LOAM_SECURITY_TELEMETRY_FILE);
