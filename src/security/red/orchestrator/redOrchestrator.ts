/**
 * Red campaign orchestrator (RED_TEAM_BUILD_SPEC §4.2, §6.1).
 *
 * The brain of the unified red capability: gate every target, recon, route to
 * capabilities (the §6.x modules), prove every claim through the existing
 * evidence gate, audit every action, and fall back to the existing (blue)
 * evidence-gated loop for plain localhost targets. Role split (planner /
 * hunter / validator / reporter — ARTEX graft) is expressed as the pure
 * functions below; the loop itself is strix's find→PoC→report lifecycle
 * rebuilt clean-room onto Loam's own orchestrator.
 */
import type { BridgeEnvelope } from "../../../bridges/types.js";
import type { PentestFinding } from "../../../tools/pentest.js";
import { coverageKey, enrichFinding, type SecurityFinding } from "../../findings.js";
import {
  evaluateEvidenceGate,
  isLocalhostTarget,
  orchestrate,
  type Evidence,
  type UnverifiedClaim,
} from "../../orchestrator.js";
import { RedAuditLog, type AuditEntry } from "../audit.js";
import { gate, loadAuthorization, RateLimiter, type AuthorizationRecord, type GateDeps } from "../gate.js";
import type { GateDecision } from "../types.js";
import { redTransport, type RedRequestEvidence, type RedTransport } from "../transport.js";
import type { RedReconAsset } from "../recon/recon.js";
import { reconTarget } from "../recon/recon.js";
import { createPtt, updateNode, type PttNode } from "./ptt.js";
import type { RedPlanner } from "./planner.js";

// ---------------------------------------------------------------------------
// Capability contracts (§6.x modules implement these)
// ---------------------------------------------------------------------------

/** How a capability invokes an external engine: always through a bridge. */
export type BridgeCaller = (bridgeId: string, commandId: string, args: Record<string, unknown>) => Promise<BridgeEnvelope>;

export interface RedCapabilityContext {
  authz: AuthorizationRecord | null;
  transport: RedTransport;
  bridge: BridgeCaller;
  audit: RedAuditLog;
  signal?: AbortSignal;
  /** Bridge workspace: engines resolve their read/write paths under it. */
  workspace?: string;
}

export interface RedHypothesis {
  id: string;
  capability: string;
  target: string;
  claim: string;
  rationale?: string;
}

export interface RedValidation {
  hypothesisId: string;
  status: "confirmed" | "refuted" | "inconclusive";
  claim: string;
  detail: string;
  evidence: Evidence[];
  /** Finding skeleton (without id) when confirmed; check names use the red_ prefix. */
  finding?: Omit<PentestFinding, "id">;
}

export interface RedCapability {
  id: string;
  applicable(target: string, recon: RedReconAsset): boolean;
  hunt(target: string, recon: RedReconAsset, ctx: RedCapabilityContext): Promise<RedHypothesis[]>;
  validate(hyp: RedHypothesis, ctx: RedCapabilityContext): Promise<RedValidation>;
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

export interface RedCampaignInput {
  goal: string;
  /** AuthorizationRecord id, or null for the localhost default posture (spec O-1). */
  authzId: string | null;
  targets: string[];
  profile?: "quick" | "campaign";
  /** Campaign-level authentication (bearer/cookie), applied to every red request. */
  auth?: { bearer?: string; cookie?: string };
}

export interface RedCampaignResult {
  campaignId: string;
  authzId: string | null;
  findings: SecurityFinding[];
  unverified: UnverifiedClaim[];
  evidence: Evidence[];
  requestEvidence: RedRequestEvidence[];
  audit: AuditEntry[];
  ptt: PttNode;
  coverage: string[];
  stats: {
    startedAt: string;
    finishedAt: string;
    requestsSent: number;
    targetsProcessed: number;
    killed: boolean;
    aborted: "budget" | null;
  };
}

export interface RunCampaignDeps {
  /** Data root for the audit log and authorization records. */
  dataRoot?: string;
  /** Bridge caller; defaults to a caller that reports every engine as missing. */
  bridge?: BridgeCaller;
  /** Bridge workspace for engines that write/read result files (ffuf, ZAP). */
  workspace?: string;
  capabilities?: RedCapability[];
  /** Optional planner (model-driven §6.1). Proposals are additive and still evidence-gated. */
  planner?: RedPlanner;
  /** Capability ids whose validate() mutates target state; gate approval applies. */
  destructiveCapabilities?: string[];
  /** Human approval callback for destructive actions (default: deny). */
  approval?: (action: { capability: string; verb: "read" | "write"; destructive?: boolean; params?: Record<string, unknown> }, authz: AuthorizationRecord | null) => boolean;
  signal?: AbortSignal;
  gateDeps?: GateDeps;
}

let campaignSeq = 0;

const noBridge: BridgeCaller = async () => ({
  ok: false,
  exitCode: null,
  timedOut: false,
  error: { type: "no_bridge", message: "no bridge caller configured" },
});

/**
 * Run one red campaign. Every target-touching action passes the §0.4 gate;
 * every reported claim passes the evidence gate ("no finding without proof");
 * every action is audited. The campaign never throws for target-level denials —
 * denials are audited and the campaign continues (budget exhaustion aborts).
 */
export async function runCampaign(input: RedCampaignInput, deps: RunCampaignDeps = {}): Promise<RedCampaignResult> {
  const startedAt = new Date().toISOString();
  const campaignId = `RED-${Date.now().toString(36)}-${String(++campaignSeq)}`;

  if (input.authzId != null) {
    const rec = loadAuthorization(input.authzId, deps.dataRoot);
    if (!rec) throw new Error(`authorization record ${input.authzId} not found`);
  }
  const authz = input.authzId ? loadAuthorization(input.authzId, deps.dataRoot)! : null;

  const audit = new RedAuditLog(deps.dataRoot);
  const limiter = new RateLimiter(authz?.limits.maxReqPerSec ?? 10, authz?.limits.maxConcurrent ?? 4);
  const authHeaders: Record<string, string> = {};
  if (input.auth?.bearer) authHeaders["authorization"] = `Bearer ${input.auth.bearer}`;
  if (input.auth?.cookie) authHeaders["cookie"] = input.auth.cookie;
  const transport = redTransport(authz, { signal: deps.signal, limiter, gateDeps: deps.gateDeps, approval: deps.approval, actionTag: "red.http", ...(Object.keys(authHeaders).length ? { authHeaders } : {}) });
  const bridge = deps.bridge ?? noBridge;
  const ctx: RedCapabilityContext = { authz, transport, bridge, audit, signal: deps.signal, ...(deps.workspace ? { workspace: deps.workspace } : {}) };

  let ptt = createPtt(input.goal || "red campaign", input.targets.map((t) => ({ goal: t })));
  const findings: SecurityFinding[] = [];
  const unverified: UnverifiedClaim[] = [];
  const coverage: string[] = [];
  const allEvidence: Evidence[] = [];
  const collectEvidence = (items: Evidence[]): void => {
    const seen = new Set(allEvidence.map((e) => e.id));
    for (const e of items) if (!seen.has(e.id)) allEvidence.push(e);
  };
  let targetsProcessed = 0;
  let killed = false;
  let aborted: "budget" | null = null;

  /** Consult the gate for a target-level action; audit every decision (§5.2). */
  const checkpoint = (target: string, action: { capability: string; verb: "read" | "write"; destructive?: boolean }): GateDecision => {
    const decision = gate(target, action, authz, {
      ...(deps.gateDeps ?? {}),
      ...(deps.approval ? { approval: (a: Parameters<NonNullable<GateDeps["approval"]>>[0], rec: Parameters<NonNullable<GateDeps["approval"]>>[1]) => deps.approval!(a, rec) } : {}),
      requestCount: () => transport.count,
    });
    if (!decision.allow) {
      audit.append({
        authzId: authz?.id ?? null,
        capability: action.capability,
        action: action.verb,
        target,
        params: {},
        outcome: "denied",
        reason: decision.reason,
      });
    } else if (decision.reason === "destructive action approved") {
      audit.append({
        authzId: authz?.id ?? null,
        capability: action.capability,
        action: action.verb,
        target,
        params: {},
        outcome: "destructive_approved",
        reason: decision.reason,
      });
    } else {
      audit.append({
        authzId: authz?.id ?? null,
        capability: action.capability,
        action: action.verb,
        target,
        params: {},
        outcome: "allowed",
        reason: decision.reason || undefined,
      });
    }
    return decision;
  };

  outer: for (const target of input.targets) {
    const node = ptt.children.find((c) => c.goal === target);
    const decision = checkpoint(target, { capability: "red.recon", verb: "read" });
    if (!decision.allow) {
      if (decision.reason === "request budget reached") {
        aborted = "budget";
        break;
      }
      if (node) ptt = updateNode(ptt, node.id, { status: "blocked", note: decision.reason });
      continue;
    }
    targetsProcessed++;

    const recon = await reconTarget(target, ctx);
    const capabilities = (deps.capabilities ?? []).filter((cap) => {
      try {
        return cap.applicable(target, recon);
      } catch {
        return false;
      }
    });

    // Model-driven planning (§6.1 PentestGPT graft): the planner only PROPOSES;
    // every proposal still passes the capability validation and the evidence gate.
    const planned = new Map<string, RedHypothesis[]>();
    if (deps.planner) {
      try {
        const proposals = await deps.planner(input.goal, [recon], capabilities.map((c) => c.id));
        let n = 0;
        for (const p of proposals) {
          const cap = p.capabilityHint ? capabilities.find((c) => c.id === p.capabilityHint) : undefined;
          if (!cap) continue;
          const list = planned.get(cap.id) ?? [];
          list.push({ id: `HYP-PLAN-${++n}`, capability: cap.id, target: p.target, claim: p.claim, ...(p.rationale ? { rationale: p.rationale } : {}) });
          planned.set(cap.id, list);
        }
        if (proposals.length) {
          audit.append({ authzId: authz?.id ?? null, capability: "red.planner", action: "plan", target, params: { proposals: proposals.length, accepted: [...planned.values()].reduce((a, b) => a + b.length, 0) }, outcome: "completed" });
        }
      } catch (err) {
        audit.append({ authzId: authz?.id ?? null, capability: "red.planner", action: "plan", target, params: {}, outcome: "failed", reason: (err as Error).message });
      }
    }

    if (capabilities.length === 0) {
      // Blue fallback (strix reuse): plain localhost targets run the existing
      // evidence-gated recon→hypothesis→validate loop unchanged.
      if (isLocalhostTarget(target)) {
        try {
          const blue = await orchestrate({ target, signal: deps.signal });
          for (const f of blue.findings) {
            findings.push(
              enrichFinding(
                { id: f.id, check: f.check, verdict: "finding", severity: f.severity, title: f.title, target: f.target, detail: f.detail },
                f.evidence.map((e) => e.id),
              ),
            );
            if (node) ptt = updateNode(ptt, node.id, { status: "proven", evidenceIds: f.evidence.map((e) => e.id) });
          }
          unverified.push(...blue.unverified);
          for (const o of blue.observations) coverage.push(coverageKey(o.target, o.check));
          collectEvidence(blue.evidence);
          audit.append({ authzId: authz?.id ?? null, capability: "red.blue_fallback", action: "orchestrate", target, params: {}, outcome: "completed", evidenceIds: blue.findings.map((f) => f.id) });
        } catch (err) {
          audit.append({ authzId: authz?.id ?? null, capability: "red.blue_fallback", action: "orchestrate", target, params: {}, outcome: "failed", reason: (err as Error).message });
          if (node) ptt = updateNode(ptt, node.id, { status: "unverified", note: "blue fallback failed" });
        }
      } else if (node) {
        ptt = updateNode(ptt, node.id, { status: "unverified", note: "no red capability applicable" });
      }
      continue;
    }

    for (const cap of capabilities) {
      const destructive = (deps.destructiveCapabilities ?? []).includes(cap.id);
      const capDecision = checkpoint(target, { capability: cap.id, verb: destructive ? "write" : "read", ...(destructive ? { destructive: true } : {}) });
      if (!capDecision.allow) {
        if (capDecision.reason === "request budget reached") {
          aborted = "budget";
          break outer;
        }
        if (capDecision.reason === "kill-switch engaged") {
          killed = true;
          audit.append({ authzId: authz?.id ?? null, capability: cap.id, action: "kill", target, params: {}, outcome: "killswitch_engaged" });
          break outer;
        }
        if (node) ptt = updateNode(ptt, node.id, { status: "unverified", note: capDecision.reason });
        continue;
      }
      coverage.push(coverageKey(target, cap.id.replace(/\./g, "_")));
      audit.append({ authzId: authz?.id ?? null, capability: cap.id, action: "hunt", target, params: {}, outcome: "started" });

      let hypotheses: RedHypothesis[];
      try {
        hypotheses = [...(await cap.hunt(target, recon, ctx)), ...(planned.get(cap.id) ?? [])];
      } catch (err) {
        audit.append({ authzId: authz?.id ?? null, capability: cap.id, action: "hunt", target, params: {}, outcome: "failed", reason: (err as Error).message });
        continue;
      }

      // Post-hunt checkpoint: budget or kill-switch abort the whole campaign.
      const post = checkpoint(target, { capability: cap.id, verb: destructive ? "write" : "read", ...(destructive ? { destructive: true } : {}) });
      if (!post.allow) {
        if (post.reason === "request budget reached") {
          aborted = "budget";
          break outer;
        }
        if (post.reason === "kill-switch engaged") {
          killed = true;
          audit.append({ authzId: authz?.id ?? null, capability: cap.id, action: "kill", target, params: {}, outcome: "killswitch_engaged" });
          break outer;
        }
      }

      for (const hyp of hypotheses) {
        const hypDecision = checkpoint(hyp.target ?? target, { capability: cap.id, verb: destructive ? "write" : "read", ...(destructive ? { destructive: true } : {}) });
        if (!hypDecision.allow) {
          if (hypDecision.reason === "request budget reached") {
            aborted = "budget";
            break outer;
          }
          if (hypDecision.reason === "kill-switch engaged") {
            killed = true;
            audit.append({ authzId: authz?.id ?? null, capability: cap.id, action: "kill", target, params: {}, outcome: "killswitch_engaged" });
            break outer;
          }
        }

        let validation: RedValidation;
        try {
          validation = await cap.validate(hyp, ctx);
        } catch (err) {
          unverified.push({ id: hyp.id, check: cap.id.replace(/\./g, "_"), target, title: hyp.claim, detail: (err as Error).message, reason: "validation failed", evidence: [] });
          audit.append({ authzId: authz?.id ?? null, capability: cap.id, action: "validate", target, params: {}, outcome: "failed", reason: (err as Error).message });
          continue;
        }

        const gateResult = evaluateEvidenceGate({ id: hyp.id, claim: validation.claim, status: validation.status, evidence: validation.evidence });
        collectEvidence(gateResult.evidence);
        if (gateResult.reported && validation.finding) {
          findings.push(
            enrichFinding({ ...validation.finding, id: hyp.id }, gateResult.evidence.map((e) => e.id)),
          );
          if (node) ptt = updateNode(ptt, node.id, { status: "proven", evidenceIds: gateResult.evidence.map((e) => e.id) });
        } else {
          unverified.push({
            id: hyp.id,
            check: cap.id.replace(/\./g, "_"),
            target,
            title: validation.claim,
            detail: validation.detail,
            reason: gateResult.reason,
            evidence: gateResult.evidence,
          });
          if (node) ptt = updateNode(ptt, node.id, { status: "unverified", note: gateResult.reason });
        }
        audit.append({
          authzId: authz?.id ?? null,
          capability: cap.id,
          action: "validate",
          target,
          params: {},
          outcome: "completed",
          reason: gateResult.reason || undefined,
          evidenceIds: gateResult.evidence.map((e) => e.id),
        });
      }
      audit.append({ authzId: authz?.id ?? null, capability: cap.id, action: "hunt", target, params: {}, outcome: "completed" });
    }
  }

  return {
    campaignId,
    authzId: authz?.id ?? null,
    findings,
    unverified,
    evidence: allEvidence,
    requestEvidence: transport.evidence,
    audit: audit.read(),
    ptt,
    coverage: [...new Set(coverage)],
    stats: {
      startedAt,
      finishedAt: new Date().toISOString(),
      requestsSent: transport.count,
      targetsProcessed,
      killed,
      aborted,
    },
  };
}
