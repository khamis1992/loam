import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface ApprovalActor {
  id: string;
  role: "approver" | "admin";
}

export interface ApprovalRequest {
  tenantId: string;
  engagementId: string;
  action: string;
  scopeHash: string;
  requesterId: string;
  destructive: boolean;
}

export interface ApprovalToken extends ApprovalRequest {
  version: 1;
  id: string;
  expiresAt: string;
  approvers: ApprovalActor[];
  signature: string;
}

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
};

export const approvalScopeHash = (scope: unknown): string => createHash("sha256").update(canonical(scope)).digest("hex");

function key(root: string): Buffer {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "approval-hmac.key");
  if (fs.existsSync(file)) {
    const result = Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
    if (result.length !== 32) throw new Error("invalid approval signing key");
    return result;
  }
  const result = randomBytes(32);
  fs.writeFileSync(file, result.toString("hex"), { mode: 0o600 });
  return result;
}

const unsigned = (token: ApprovalToken): Omit<ApprovalToken, "signature"> => {
  const { signature: _signature, ...rest } = token;
  return rest;
};

export class ApprovalService {
  constructor(private readonly root: string) {}

  private sign(value: unknown): string {
    return createHmac("sha256", key(this.root)).update(canonical(value)).digest("hex");
  }

  issue(request: ApprovalRequest, approvers: ApprovalActor[], expiresInSeconds = 300): ApprovalToken {
    if (!/^[A-Za-z0-9_.@-]+$/.test(request.tenantId) || !/^[A-Za-z0-9_.@-]+$/.test(request.engagementId)) throw new Error("invalid tenant or engagement");
    if (!/^[a-f0-9]{64}$/.test(request.scopeHash)) throw new Error("invalid approval scope hash");
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 3600) throw new Error("approval expiry must be between 1 and 3600 seconds");
    if (approvers.some((actor) => actor.id === request.requesterId)) throw new Error("requester cannot approve their own action");
    if (new Set(approvers.map((actor) => actor.id)).size !== approvers.length) throw new Error("approvers must be distinct");
    if (approvers.length < (request.destructive ? 2 : 1)) throw new Error(request.destructive ? "destructive actions require two independent approvers" : "approval required");
    const token: ApprovalToken = {
      ...request,
      version: 1,
      id: `APR-${randomBytes(16).toString("hex")}`,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      approvers: approvers.map((actor) => ({ ...actor })),
      signature: "",
    };
    token.signature = this.sign(unsigned(token));
    return token;
  }

  verify(token: ApprovalToken, expected: ApprovalRequest, consume = true): { ok: boolean; reason: string } {
    try {
      if (token.version !== 1 || !/^[a-f0-9]{64}$/i.test(token.signature)) return { ok: false, reason: "invalid approval token" };
      const actual = Buffer.from(token.signature, "hex");
      const wanted = Buffer.from(this.sign(unsigned(token)), "hex");
      if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return { ok: false, reason: "invalid approval signature" };
      for (const field of ["tenantId", "engagementId", "action", "scopeHash", "requesterId", "destructive"] as const) {
        if (token[field] !== expected[field]) return { ok: false, reason: `approval ${field} mismatch` };
      }
      if (Date.parse(token.expiresAt) <= Date.now()) return { ok: false, reason: "approval expired" };
      if (token.approvers.some((actor) => actor.id === token.requesterId)) return { ok: false, reason: "self approval is forbidden" };
      if (new Set(token.approvers.map((actor) => actor.id)).size !== token.approvers.length) return { ok: false, reason: "approvers must be distinct" };
      if (token.approvers.length < (token.destructive ? 2 : 1)) return { ok: false, reason: "insufficient independent approvals" };
      if (!consume) return { ok: true, reason: "" };
      const usedDir = path.join(this.root, "consumed-approvals");
      fs.mkdirSync(usedDir, { recursive: true });
      fs.writeFileSync(path.join(usedDir, `${token.id}.json`), JSON.stringify({ id: token.id, usedAt: new Date().toISOString() }), { flag: "wx" });
      return { ok: true, reason: "" };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { ok: false, reason: code === "EEXIST" ? "approval already used" : "approval verification failed" };
    }
  }
}
