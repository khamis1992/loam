/**
 * Adversary simulation (RED_TEAM_BUILD_SPEC §6.9) — apache/caldera (Apache-2.0)
 * driven through its REST API in the isolated lab only. The value for Loam is
 * ATT&CK-mapped coverage of its own detection, so every executed ability maps
 * into the campaign report. The planner itself stays in caldera (spec: direct
 * call / reverse-engineer later); we only rebuild the client surface.
 */
import type { RedCapabilityContext } from "../orchestrator/redOrchestrator.js";

export interface AdversaryProfile {
  id: string;
  name: string;
  abilities: { attackId: string; name: string }[];
}

export interface AttckCoverage {
  operationId: string;
  executed: { attackId: string; name: string; result: string }[];
}

export interface CalderaOptions {
  maxPolls?: number;
  pollDelayMs?: number;
}

/** GET /api/adversaries — list caldera adversary profiles (lab only). */
export async function listAdversaries(base: string, ctx: RedCapabilityContext): Promise<AdversaryProfile[]> {
  const res = await ctx.transport.request(`${base.replace(/\/+$/, "")}/api/adversaries`);
  if (res.status !== 200) throw new Error(`caldera adversaries unavailable: HTTP ${res.status}`);
  let doc: unknown;
  try {
    doc = JSON.parse(res.body);
  } catch {
    throw new Error("caldera adversaries response was not JSON");
  }
  const list = Array.isArray(doc) ? doc : (doc as { adversaries?: unknown[] }).adversaries ?? [];
  const out: AdversaryProfile[] = [];
  for (const raw of list) {
    const o = raw as Record<string, unknown>;
    const id = typeof o.adversary_id === "string" ? o.adversary_id : typeof o.id === "string" ? o.id : "";
    const name = typeof o.name === "string" ? o.name : "";
    if (!id || !name) continue;
    out.push({ id, name, abilities: [] });
  }
  return out;
}

/**
 * POST /api/operations to start an operation for the profile against the lab
 * hosts, then poll until finished. Returns the ATT&CK-mapped coverage of every
 * executed ability. `base` must be a localhost lab caldera (gate enforced by
 * the transport itself).
 */
export async function runOperation(
  base: string,
  profile: AdversaryProfile,
  labHosts: string[],
  ctx: RedCapabilityContext,
  opts: CalderaOptions = {},
): Promise<AttckCoverage> {
  const root = base.replace(/\/+$/, "");
  const maxPolls = opts.maxPolls ?? 20;
  const pollDelayMs = opts.pollDelayMs ?? 250;
  const created = await ctx.transport.request(`${root}/api/operations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `loam-${Date.now()}`, adversary: { adversary_id: profile.id }, group: "loam-lab", hosts: labHosts }),
  });
  if (created.status !== 200 && created.status !== 201) throw new Error(`caldera operation not created: HTTP ${created.status}`);
  let operationId = "";
  try {
    operationId = String((JSON.parse(created.body) as { id?: unknown }).id ?? "");
  } catch {
    /* some caldera versions return the id in a Location-ish plain body */
    operationId = created.body.replace(/\D/g, "").slice(0, 36);
  }
  if (!operationId) throw new Error("caldera operation id missing");

  for (let poll = 0; poll < maxPolls; poll++) {
    const res = await ctx.transport.request(`${root}/api/operations/${operationId}`);
    if (res.status === 200) {
      let doc: Record<string, unknown> | null = null;
      try {
        doc = JSON.parse(res.body) as Record<string, unknown>;
      } catch {
        doc = null;
      }
      const state = doc ? String(doc.state ?? "") : "";
      if (state === "finished" || state === "completed") {
        const chain = Array.isArray(doc?.chain) ? (doc!.chain as unknown[]) : [];
        const executed: AttckCoverage["executed"] = [];
        for (const link of chain) {
          const l = link as { ability?: Record<string, unknown>; status?: unknown };
          const ability = l.ability ?? {};
          const attackId = typeof ability.technique_id === "string" ? ability.technique_id : "";
          const name = typeof ability.name === "string" ? ability.name : "";
          if (!attackId && !name) continue;
          executed.push({ attackId: attackId || "unknown", name, result: String(l.status ?? "unknown") });
        }
        return { operationId, executed };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
  }
  throw new Error(`caldera operation ${operationId} did not finish within ${maxPolls} polls`);
}
