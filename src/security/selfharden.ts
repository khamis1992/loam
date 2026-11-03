/**
 * Skill distillation (ALL_SERVICES §17, hivemind technique): summarize a successful
 * run trace into a candidate SKILL.md. The candidate is inert until it passes the
 * supply-chain scan (§9/skillkit gate) and operator review — auto-authoring never
 * silently activates anything.
 */
export interface RunTraceStep { tool: string; summary: string }
export interface RunTrace { goal: string; steps: RunTraceStep[]; outcome: "success" | "partial" | "failure" }

export interface DistilledSkill {
  slug: string;
  frontmatter: { name: string; description: string; triggers: string[]; source: "learned" };
  body: string;
  status: "candidate";
}

/** Extract the reusable procedure: dedupe repeated tools, keep goal-ordered steps. */
export function distillSkill(trace: RunTrace): DistilledSkill | null {
  if (trace.outcome !== "success" || trace.steps.length < 3) return null;
  const seen = new Set<string>();
  const steps = trace.steps.filter((s) => {
    const key = `${s.tool}\u0000${s.summary.slice(0, 60)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
  const verbs = [...new Set(steps.map((s) => s.tool))].slice(0, 5);
  const slugBase = trace.goal.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "learned-skill";
  return {
    slug: `learned-${slugBase}`,
    frontmatter: {
      name: `Learned: ${trace.goal.slice(0, 60)}`,
      description: `Procedure recovered from a successful run (${steps.length} steps, tools: ${verbs.join(", ")}).`,
      triggers: verbs,
      source: "learned",
    },
    body: [
      `# Learned procedure — ${trace.goal}`,
      "",
      "Recovered automatically from a successful run. Review, then run the supply-chain scan before activation.",
      "",
      ...steps.map((s, i) => `${i + 1}. **${s.tool}** — ${s.summary.replace(/\n/g, " ").slice(0, 160)}`),
    ].join("\n"),
    status: "candidate",
  };
}

/** Render the candidate to SKILL.md content (caller persists after review). */
export const toSkillDoc = (skill: DistilledSkill): string =>
  `---\nname: ${skill.frontmatter.name}\ndescription: ${JSON.stringify(skill.frontmatter.description)}\ntriggers: ${JSON.stringify(skill.frontmatter.triggers)}\nsource: ${skill.frontmatter.source}\n---\n\n${skill.body}\n`;
