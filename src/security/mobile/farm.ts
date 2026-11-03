import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export interface FarmDevice {
  id: string;
  platform: "android" | "ios";
  osVersion: string;
  capabilities: string[];
  workerVersion: string;
  imageDigest: string;
  health: "healthy" | "offline" | "quarantined";
  leaseTenantId?: string;
  leaseEngagementId?: string;
  leaseUntil?: number;
}

export interface DeviceRequirement {
  platform: "android" | "ios";
  osVersion?: string;
  capabilities?: string[];
}

export class MobileDeviceFarm {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`CREATE TABLE IF NOT EXISTS devices(
      id TEXT PRIMARY KEY, platform TEXT NOT NULL, os_version TEXT NOT NULL, capabilities TEXT NOT NULL,
      worker_version TEXT NOT NULL, image_digest TEXT NOT NULL, health TEXT NOT NULL,
      lease_tenant TEXT, lease_engagement TEXT, lease_until INTEGER, heartbeat_at INTEGER NOT NULL)`);
  }

  register(device: FarmDevice): void {
    if (!/^[A-Za-z0-9_.:-]+$/.test(device.id) || !/^sha256:[a-f0-9]{64}$/.test(device.imageDigest)) throw new Error("invalid device identity or worker image digest");
    this.db.prepare(`INSERT INTO devices(id,platform,os_version,capabilities,worker_version,image_digest,health,heartbeat_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET platform=excluded.platform,os_version=excluded.os_version,capabilities=excluded.capabilities,worker_version=excluded.worker_version,image_digest=excluded.image_digest,health=excluded.health,heartbeat_at=excluded.heartbeat_at`).run(device.id, device.platform, device.osVersion, JSON.stringify([...new Set(device.capabilities)]), device.workerVersion, device.imageDigest, device.health, Date.now());
  }

  heartbeat(id: string, healthy: boolean): void {
    if (this.db.prepare("UPDATE devices SET health=?,heartbeat_at=? WHERE id=? AND lease_tenant IS NULL").run(healthy ? "healthy" : "offline", Date.now(), id).changes !== 1) throw new Error("device is missing or leased");
  }

  lease(tenantId: string, engagementId: string, requirement: DeviceRequirement, leaseMs = 60_000): FarmDevice | null {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare("SELECT * FROM devices WHERE platform=? AND health='healthy'").all(requirement.platform) as Array<Record<string, unknown>>;
      const candidate = rows.find((row) => {
        const leased = typeof row.lease_until === "number" && row.lease_until > now;
        const capabilities = JSON.parse(String(row.capabilities)) as string[];
        return !leased && (!requirement.osVersion || row.os_version === requirement.osVersion) && (requirement.capabilities ?? []).every((capability) => capabilities.includes(capability));
      });
      if (!candidate) { this.db.exec("COMMIT"); return null; }
      const id = String(candidate.id);
      this.db.prepare("UPDATE devices SET lease_tenant=?,lease_engagement=?,lease_until=? WHERE id=?").run(tenantId, engagementId, now + leaseMs, id);
      this.db.exec("COMMIT");
      return this.get(id);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  release(tenantId: string, engagementId: string, deviceId: string, cleanup: { success: boolean; evidenceSha256: string }): FarmDevice {
    if (!/^[a-f0-9]{64}$/.test(cleanup.evidenceSha256)) throw new Error("cleanup evidence hash required");
    const device = this.get(deviceId);
    if (device.leaseTenantId !== tenantId || device.leaseEngagementId !== engagementId) throw new Error("device lease mismatch");
    this.db.prepare("UPDATE devices SET health=?,lease_tenant=NULL,lease_engagement=NULL,lease_until=NULL,heartbeat_at=? WHERE id=?").run(cleanup.success ? "healthy" : "quarantined", Date.now(), deviceId);
    return this.get(deviceId);
  }

  quarantine(id: string): void {
    this.db.prepare("UPDATE devices SET health='quarantined',lease_tenant=NULL,lease_engagement=NULL,lease_until=NULL,heartbeat_at=? WHERE id=?").run(Date.now(), id);
  }

  recoverExpired(now = Date.now()): number {
    return Number(this.db.prepare("UPDATE devices SET health='quarantined',lease_tenant=NULL,lease_engagement=NULL,lease_until=NULL WHERE lease_until<?").run(now).changes);
  }

  get(id: string): FarmDevice {
    const row = this.db.prepare("SELECT * FROM devices WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error("device not found");
    return {
      id,
      platform: row.platform as FarmDevice["platform"],
      osVersion: String(row.os_version),
      capabilities: JSON.parse(String(row.capabilities)),
      workerVersion: String(row.worker_version),
      imageDigest: String(row.image_digest),
      health: row.health as FarmDevice["health"],
      ...(row.lease_tenant ? { leaseTenantId: String(row.lease_tenant) } : {}),
      ...(row.lease_engagement ? { leaseEngagementId: String(row.lease_engagement) } : {}),
      ...(typeof row.lease_until === "number" ? { leaseUntil: row.lease_until } : {}),
    };
  }

  list(): FarmDevice[] {
    return (this.db.prepare("SELECT id FROM devices ORDER BY id").all() as Array<{ id: string }>).map((row) => this.get(row.id));
  }

  close(): void { this.db.close(); }
}
