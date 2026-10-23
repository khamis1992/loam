import { proposeInstructions } from "../../server/instructionHistory.js";
import { listLessons } from "./experienceStore.js";

export const PROMOTE_MIN_USES = 3;

/** Promote high-confidence, repeatedly-used lessons into a *proposed* instruction edit (never auto-approved). */
export function proposePromotions(agentId: string, currentInstructions: string): string | null {
  const ready = listLessons({ agentId }).filter(
    (l) =>
      l.agentId === agentId &&
      l.confidence === "high" &&
      l.uses >= PROMOTE_MIN_USES &&
      !currentInstructions.includes(l.lesson),
  );
  if (!ready.length) return null;
  const add = ready.map((l) => `- When ${l.cue.replace(/\.$/, "")}: ${l.lesson}`).join("\n");
  const base = currentInstructions.trimEnd();
  const next = base ? `${base}\n\n## Learned rules\n${add}\n` : `## Learned rules\n${add}\n`;
  return proposeInstructions(
    agentId,
    next,
    `Promote ${ready.length} learned lesson(s): ${ready.map((l) => l.id).join(", ")}`,
  ).id;
}
