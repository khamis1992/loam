/**
 * Pentest Task Tree (RED_TEAM_BUILD_SPEC §6.1, graft from PentestGPT).
 *
 * An explicit state object so a long engagement does not lose state between
 * steps. Every proven node links the EV-#### evidence ids that proved it.
 */

export type PttStatus = "todo" | "doing" | "proven" | "unverified" | "blocked";

export interface PttNode {
  id: string;
  goal: string;
  status: PttStatus;
  children: PttNode[];
  evidenceIds: string[];
  note?: string;
}

let seq = 0;
const nextId = (): string => `PTT${String(++seq).padStart(4, "0")}`;

/** Root "doing" node with one child per task. */
export function createPtt(goal: string, tasks: ReadonlyArray<{ goal: string; note?: string }>): PttNode {
  const root: PttNode = { id: nextId(), goal, status: "doing", children: [], evidenceIds: [] };
  for (const task of tasks) {
    root.children.push({ id: nextId(), goal: task.goal, status: "todo", children: [], evidenceIds: [], ...(task.note ? { note: task.note } : {}) });
  }
  return root;
}

const patchNode = (node: PttNode, id: string, patch: Partial<Pick<PttNode, "status" | "evidenceIds" | "note">>): PttNode => {
  const next: PttNode = { ...node, children: node.children.map((c) => patchNode(c, id, patch)) };
  if (node.id === id) {
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.evidenceIds !== undefined) next.evidenceIds = [...new Set([...next.evidenceIds, ...patch.evidenceIds])];
    if (patch.note !== undefined) next.note = patch.note;
  }
  return next;
};

/** Pure update: returns a new tree; the original is never mutated. */
export function updateNode(root: PttNode, id: string, patch: Partial<Pick<PttNode, "status" | "evidenceIds" | "note">>): PttNode {
  return patchNode(root, id, patch);
}

/** Depth-first walk of the whole tree, root first. */
export function flatten(root: PttNode): PttNode[] {
  const out: PttNode[] = [root];
  for (const child of root.children) out.push(...flatten(child));
  return out;
}
