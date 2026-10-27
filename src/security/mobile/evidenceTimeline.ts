import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EvidenceCipher, EncryptedEvidence } from "../enterprise/crypto.js";
import { redactText } from "../red/audit.js";

export type TimelineKind = "screen" | "request" | "code" | "log" | "device" | "manual";

export interface TimelineEventInput {
  kind: TimelineKind;
  summary: string;
  content?: string;
  at?: string;
  relatedFindingIds?: string[];
  artifactSha256?: string;
}

export interface TimelineEvent {
  id: string;
  tenantId: string;
  engagementId: string;
  seq: number;
  at: string;
  kind: TimelineKind;
  summary: string;
  content?: string;
  encrypted?: EncryptedEvidence;
  relatedFindingIds: string[];
  sha256: string;
}

const ids = (value: string): void => { if (!/^[A-Za-z0-9_.@-]+$/.test(value)) throw new Error("invalid timeline identity"); };

export class EvidenceTimeline {
  constructor(private readonly root: string, private readonly cipher?: EvidenceCipher) {}

  private file(tenantId: string, engagementId: string): string {
    ids(tenantId); ids(engagementId);
    return path.join(this.root, tenantId, `${engagementId}.jsonl`);
  }

  async append(tenantId: string, engagementId: string, input: TimelineEventInput): Promise<TimelineEvent> {
    const file = this.file(tenantId, engagementId);
    const existing = await this.list(tenantId, engagementId);
    const content = redactText(input.content ?? "").slice(0, 1_000_000);
    const event: TimelineEvent = {
      id: `EV-${randomBytes(10).toString("hex")}`,
      tenantId,
      engagementId,
      seq: existing.length + 1,
      at: input.at ?? new Date().toISOString(),
      kind: input.kind,
      summary: redactText(input.summary).slice(0, 1000),
      relatedFindingIds: [...new Set(input.relatedFindingIds ?? [])],
      sha256: input.artifactSha256 ?? createHash("sha256").update(content).digest("hex"),
    };
    if (this.cipher && content) event.encrypted = await this.cipher.encrypt(tenantId, engagementId, event.id, content);
    else if (content) event.content = content;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + "\n", { mode: 0o600 });
    return event;
  }

  async list(tenantId: string, engagementId: string): Promise<TimelineEvent[]> {
    const file = this.file(tenantId, engagementId);
    if (!fs.existsSync(file)) return [];
    const events = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as TimelineEvent);
    if (events.some((event) => event.tenantId !== tenantId || event.engagementId !== engagementId)) throw new Error("timeline tenant integrity failure");
    const decrypted: TimelineEvent[] = [];
    for (const event of events.sort((a, b) => a.seq - b.seq)) {
      if (event.encrypted) {
        if (!this.cipher) throw new Error("KMS is required to read encrypted timeline evidence");
        event.content = (await this.cipher.decrypt(tenantId, engagementId, event.id, event.encrypted)).toString("utf8");
      }
      decrypted.push(event);
    }
    return decrypted;
  }
}
