/**
 * Red campaign planner (RED_TEAM_BUILD_SPEC §6.1 — PentestGPT reasoning graft).
 *
 * A planner proposes test claims for the campaign. Two implementations:
 *  - `rulePlanner`: deterministic, mirroring the classic capability hunts.
 *  - `llmPlanner`: model-driven planning. The model only ever PROPOSES;
 *    every proposal still has to survive a capability's validation and the
 *    structural evidence gate ("no finding without proof"), so a hallucinated
 *    claim can never become a finding — it lands in `unverified`.
 */
import type { RedReconAsset } from "../recon/recon.js";

export interface PlannerProposal {
  target: string;
  claim: string;
  rationale?: string;
  /** Capability id that should validate the claim (must be registered). */
  capabilityHint?: string;
}

export type RedPlanner = (goal: string, assets: RedReconAsset[], capabilityIds: string[]) => Promise<PlannerProposal[]>;

/** Deterministic fallback: one generic recon-depth proposal per asset. */
export const rulePlanner: RedPlanner = async (_goal, assets, capabilityIds) => {
  const out: PlannerProposal[] = [];
  for (const asset of assets) {
    for (const cap of capabilityIds) {
      out.push({
        target: asset.target,
        claim: `${cap} surface on ${asset.target}`,
        rationale: "rule-based coverage proposal",
        capabilityHint: cap,
      });
    }
  }
  return out;
};

const extractJsonArray = (text: string): unknown[] | null => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]!.trim() : text.trim();
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** Validate one raw proposal; garbage is dropped, never thrown. */
export function normalizeProposal(raw: unknown, validTargets: Set<string>, capabilityIds: string[]): PlannerProposal | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const target = typeof o.target === "string" ? o.target.trim() : "";
  const claim = typeof o.claim === "string" ? o.claim.trim() : "";
  if (!target || !validTargets.has(target) || !claim || claim.length > 300) return null;
  // A proposal is only actionable when it names a registered capability;
  // hint-less or unknown-hint proposals are dropped here (upstream only
  // validates hinted proposals).
  const hint = typeof o.capabilityHint === "string" ? o.capabilityHint.trim() : "";
  if (!hint || !capabilityIds.includes(hint)) return null;
  return {
    target,
    claim: claim.slice(0, 300),
    ...(typeof o.rationale === "string" && o.rationale.trim() ? { rationale: o.rationale.trim().slice(0, 300) } : {}),
    capabilityHint: hint,
  };
}

/** Model-driven planner. `chat` receives the full prompt and returns raw text. */
export function llmPlanner(chat: (prompt: string, signal?: AbortSignal) => Promise<string>): RedPlanner {
  return async (goal, assets, capabilityIds) => {
    if (!assets.length || !capabilityIds.length) return [];
    const prompt = [
      "You are the planning step of an authorized red-team campaign (owned lab systems only).",
      `Campaign goal: ${goal}`,
      "Reconnaissance assets (target + fingerprint):",
      ...assets.map((a) => `- ${a.target}${a.techFingerprint.length ? ` [${a.techFingerprint.join(", ")}]` : ""}${a.title ? ` "${a.title}"` : ""}`),
      "Available validation capabilities: " + capabilityIds.join(", "),
      "",
      "Propose the highest-value test claims for these assets. Respond ONLY with a JSON array:",
      '[{"target":"<exact target URL>","claim":"<falsifiable security claim>","rationale":"<why>","capabilityHint":"<one capability id>"}]',
      "Rules: targets must be copied exactly from the assets above; capabilityHint must be one of the listed ids; claims must be specific and testable. Max 8 proposals.",
    ].join("\n");
    let raw: string;
    try {
      raw = await chat(prompt);
    } catch {
      return []; // a planner failure degrades to rule-based behaviour upstream
    }
    const validTargets = new Set(assets.map((a) => a.target));
    const parsed = extractJsonArray(raw);
    if (!parsed) return [];
    const proposals: PlannerProposal[] = [];
    for (const item of parsed.slice(0, 12)) {
      const p = normalizeProposal(item, validTargets, capabilityIds);
      if (p) proposals.push(p);
    }
    return proposals;
  };
}
