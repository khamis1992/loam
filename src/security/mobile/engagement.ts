import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RawFinding } from "../normalize/types.js";
import type { MobileArtifact } from "./artifacts.js";
import type { MobileArtifactScanResult } from "./mobsfBridge.js";
import { initialMasvsCoverage, masvsSummary, reviewMasvsControl, type MasvsCoverage } from "./masvs.js";

export type MobileEngagementStage = "Draft" | "Authorized" | "Running" | "QA" | "Delivered" | "Retest" | "Closed";

export interface MobileFinding extends RawFinding {
  id: string;
  reviewerId?: string;
  retest?: { status: "fixed" | "persistent" | "inconclusive"; evidenceIds: string[]; reviewerId: string; at: string };
}

export interface MobileEngagement {
  version: 1;
  id: string;
  tenantId: string;
  ownerId: string;
  stage: MobileEngagementStage;
  createdAt: string;
  updatedAt: string;
  authorization?: { id: string; statement: string; expiresAt: string; approvedBy: string };
  artifacts: MobileArtifact[];
  scans: MobileArtifactScanResult[];
  findings: MobileFinding[];
  coverage: MasvsCoverage[];
  evidence: Array<{ id: string; kind: "static" | "dynamic" | "manual" | "retest"; summary: string; sha256: string; at: string }>;
  qaReviewerId?: string;
  events: Array<{ at: string; actorId: string; from: MobileEngagementStage; to: MobileEngagementStage }>;
  signature: string;
}

export interface CreateEngagementInput {
  tenantId: string;
  ownerId: string;
  artifacts: MobileArtifact[];
}

type UnsignedEngagement = Omit<MobileEngagement, "signature">;

const identifier = (value: string, label: string): void => {
  if (!/^[A-Za-z0-9_.@-]{1,128}$/.test(value)) throw new Error(`invalid ${label}`);
};

function engagementKey(root: string): Buffer {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "engagement-hmac.key");
  if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
  const value = randomBytes(32);
  fs.writeFileSync(file, value.toString("hex"), { mode: 0o600 });
  return value;
}

export class MobileEngagementStore {
  constructor(private readonly root: string) {}

  private sign(value: UnsignedEngagement): string {
    return createHmac("sha256", engagementKey(this.root)).update(JSON.stringify(value)).digest("hex");
  }

  private file(tenantId: string, id: string): string {
    identifier(tenantId, "tenantId");
    identifier(id, "engagementId");
    return path.join(this.root, "engagements", tenantId, `${id}.json`);
  }

  private write(state: MobileEngagement): MobileEngagement {
    state.updatedAt = new Date().toISOString();
    const { signature: _old, ...unsigned } = state;
    state.signature = this.sign(unsigned);
    const file = this.file(state.tenantId, state.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return state;
  }

  create(input: CreateEngagementInput): MobileEngagement {
    identifier(input.tenantId, "tenantId");
    identifier(input.ownerId, "ownerId");
    if (!input.artifacts.length) throw new Error("at least one mobile artifact is required");
    const now = new Date().toISOString();
    const state: MobileEngagement = {
      version: 1,
      id: `MOB-${randomBytes(12).toString("hex")}`,
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      stage: "Draft",
      createdAt: now,
      updatedAt: now,
      artifacts: input.artifacts.map((artifact) => ({ ...artifact })),
      scans: [],
      findings: [],
      coverage: initialMasvsCoverage(),
      evidence: [],
      events: [],
      signature: "",
    };
    return this.write(state);
  }

  get(tenantId: string, id: string): MobileEngagement {
    const state = JSON.parse(fs.readFileSync(this.file(tenantId, id), "utf8")) as MobileEngagement;
    const { signature, ...unsigned } = state;
    const expected = Buffer.from(this.sign(unsigned), "hex");
    const actual = Buffer.from(signature ?? "", "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("mobile engagement integrity check failed");
    if (state.tenantId !== tenantId || state.id !== id) throw new Error("mobile engagement tenant mismatch");
    return state;
  }

  update(state: MobileEngagement): MobileEngagement {
    const current = this.get(state.tenantId, state.id);
    if (current.updatedAt !== state.updatedAt) throw new Error("mobile engagement was modified concurrently");
    return this.write(state);
  }

  list(tenantId: string): MobileEngagement[] {
    identifier(tenantId, "tenantId");
    const dir = path.join(this.root, "engagements", tenantId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((file) => file.endsWith(".json")).sort().map((file) => this.get(tenantId, file.slice(0, -5)));
  }
}

export function authorizeMobileEngagement(state: MobileEngagement, authorization: NonNullable<MobileEngagement["authorization"]>): MobileEngagement {
  if (state.stage !== "Draft") throw new Error("only draft engagements can be authorized");
  if (Date.parse(authorization.expiresAt) <= Date.now()) throw new Error("authorization is expired");
  if (!authorization.id.trim() || !authorization.statement.trim() || !authorization.approvedBy.trim()) throw new Error("authorization is incomplete");
  state.authorization = { ...authorization };
  return transitionMobileEngagement(state, "Authorized", authorization.approvedBy);
}

const transitions: Record<MobileEngagementStage, MobileEngagementStage[]> = {
  Draft: ["Authorized"],
  Authorized: ["Running"],
  Running: ["QA"],
  QA: ["Delivered"],
  Delivered: ["Retest"],
  Retest: ["Closed"],
  Closed: [],
};

export function transitionMobileEngagement(state: MobileEngagement, to: MobileEngagementStage, actorId: string): MobileEngagement {
  identifier(actorId, "actorId");
  if (!transitions[state.stage].includes(to)) throw new Error(`invalid mobile engagement transition ${state.stage} -> ${to}`);
  if (to === "Authorized" && (!state.authorization || Date.parse(state.authorization.expiresAt) <= Date.now())) throw new Error("valid authorization required");
  if (to === "Running" && !state.artifacts.length) throw new Error("artifacts required");
  if (to === "QA") {
    if (state.scans.length !== state.artifacts.length || state.scans.some((scan) => scan.status === "unavailable" || scan.status === "error")) throw new Error("all artifacts need a conclusive static scan before QA");
  }
  if (to === "Delivered") {
    if (!state.qaReviewerId || state.qaReviewerId === state.ownerId) throw new Error("independent QA review required");
    if (!masvsSummary(state.coverage).complete) throw new Error("MASVS coverage is incomplete");
    if (state.findings.some((finding) => !finding.reviewerId)) throw new Error("all findings require human review");
  }
  if (to === "Closed" && state.findings.some((finding) => ["critical", "high"].includes(finding.severity) && finding.retest?.status !== "fixed")) throw new Error("critical and high findings require a fixed retest");
  state.events.push({ at: new Date().toISOString(), actorId, from: state.stage, to });
  state.stage = to;
  return state;
}

export function recordMobileScan(state: MobileEngagement, result: MobileArtifactScanResult): MobileEngagement {
  if (state.stage !== "Running") throw new Error("scans are accepted only while running");
  if (!state.artifacts.some((artifact) => artifact.sha256 === result.artifact.sha256)) throw new Error("scan artifact is outside the engagement");
  state.scans = [...state.scans.filter((scan) => scan.artifact.sha256 !== result.artifact.sha256), result];
  const findings = result.findings.map((finding): MobileFinding => ({
    ...finding,
    id: createHash("sha256").update(`${result.artifact.sha256}\n${finding.ruleId}\n${finding.target}\n${finding.title}`).digest("hex").slice(0, 24),
  }));
  const incoming = new Set(findings.map((finding) => finding.id));
  state.findings = [...state.findings.filter((finding) => !incoming.has(finding.id)), ...findings];
  state.evidence.push({ id: `EV-${randomBytes(8).toString("hex")}`, kind: "static", summary: `MobSF ${result.status}: ${result.artifact.relativePath}`, sha256: result.reportSha256 ?? result.artifact.sha256, at: new Date().toISOString() });
  return state;
}

export function reviewMobileFinding(state: MobileEngagement, findingId: string, reviewerId: string): MobileEngagement {
  const finding = state.findings.find((item) => item.id === findingId);
  if (!finding) throw new Error("finding not found");
  if (reviewerId === state.ownerId) throw new Error("finding review must be independent");
  finding.reviewerId = reviewerId;
  return state;
}

export function setMobileCoverage(state: MobileEngagement, coverage: MasvsCoverage, reviewerId: string): MobileEngagement {
  const index = state.coverage.findIndex((entry) => entry.controlId === coverage.controlId);
  if (index < 0) throw new Error("unknown MASVS control");
  state.coverage[index] = reviewMasvsControl(coverage, reviewerId);
  return state;
}

export function reviewMobileQa(state: MobileEngagement, reviewerId: string): MobileEngagement {
  if (state.stage !== "QA") throw new Error("engagement must be in QA");
  if (reviewerId === state.ownerId) throw new Error("QA reviewer must be independent");
  identifier(reviewerId, "reviewerId");
  state.qaReviewerId = reviewerId;
  return state;
}

export function recordMobileRetest(state: MobileEngagement, findingId: string, result: NonNullable<MobileFinding["retest"]>): MobileEngagement {
  if (state.stage !== "Retest") throw new Error("engagement must be in retest");
  const finding = state.findings.find((item) => item.id === findingId);
  if (!finding) throw new Error("finding not found");
  if (!result.evidenceIds.length || !result.reviewerId) throw new Error("retest requires evidence and a reviewer");
  finding.retest = { ...result, evidenceIds: [...result.evidenceIds] };
  return state;
}
