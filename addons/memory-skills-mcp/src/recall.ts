import type { Episodes } from "./episodes.js";
import type { Facts } from "./facts.js";
import type { Skills } from "./skills.js";
import { snippet } from "./util.js";

export async function buildRecall(
  episodes: Episodes,
  facts: Facts,
  skills: Skills,
  goal: string,
  k = 3,
): Promise<string> {
  const [ep, fa, sk] = await Promise.all([
    episodes.search(goal, { k }),
    facts.search(goal, { k }),
    skills.search(goal, { k: Math.min(k, 3) }),
  ]);

  const lines: string[] = [];
  lines.push(`# Recalled context for: ${snippet(goal, 200)}`);

  if (ep.length > 0) {
    lines.push("", "## Similar past tasks (episodic memory)");
    for (const h of ep) {
      const e = h.episode;
      lines.push(`- [${e.createdAt.slice(0, 10)} · ${e.outcome} · ${h.score.toFixed(2)}] ${snippet(e.goal, 140)} — ${snippet(e.summary, 240)} (${e.id})`);
      if (e.lessons.length > 0) lines.push(`  lessons: ${snippet(e.lessons.join(" | "), 240)}`);
    }
  }

  if (fa.length > 0) {
    lines.push("", "## Durable facts & preferences (semantic memory)");
    for (const h of fa) lines.push(`- (${h.score.toFixed(2)}) [${h.fact.kind}] ${snippet(h.fact.text, 240)} (${h.fact.id})`);
  }

  if (sk.length > 0) {
    lines.push("", "## Reusable skills (procedural memory) — call skill_get to load one");
    for (const h of sk) {
      const rate = h.stats.uses > 0 ? `${Math.round(h.stats.successRate * 100)}% over ${h.stats.uses}` : "untried";
      lines.push(`- ${h.slug} (${rate}): ${snippet(h.description, 180)}`);
    }
  }

  if (ep.length === 0 && fa.length === 0 && sk.length === 0) {
    lines.push("", "(nothing relevant remembered yet — after this task call episode_record so future runs can recall it)");
  }
  return lines.join("\n");
}
