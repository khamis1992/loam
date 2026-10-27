export interface AttackNode {
  id: string;
  kind: "application" | "screen" | "api" | "identity" | "data" | "control";
  label: string;
  sensitive?: boolean;
}

export interface AttackEdge {
  from: string;
  to: string;
  action: string;
  evidenceIds: string[];
}

export interface AttackPathResult {
  nodes: AttackNode[];
  edges: AttackEdge[];
  action: string;
  evidenceIds: string[];
  impact: string;
}

export function buildAttackPaths(nodes: AttackNode[], edges: AttackEdge[]): AttackPathResult[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) throw new Error("duplicate attack node");
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) throw new Error("attack edge references unknown node");
    if (!edge.evidenceIds.length) throw new Error("attack edges require evidence provenance");
  }
  const results: AttackPathResult[] = [];
  const visit = (nodeId: string, path: AttackNode[], usedEdges: AttackEdge[]): void => {
    if (results.length >= 20 || path.length > 10) return;
    const node = byId.get(nodeId)!;
    if (node.kind === "data" && node.sensitive && path.length > 1) {
      results.push({ nodes: [...path], edges: [...usedEdges], action: usedEdges.map((edge) => edge.action).join(" → "), evidenceIds: [...new Set(usedEdges.flatMap((edge) => edge.evidenceIds))], impact: `Evidence-backed path reaches ${node.label}` });
      return;
    }
    for (const edge of edges.filter((candidate) => candidate.from === nodeId)) {
      if (path.some((item) => item.id === edge.to)) continue;
      visit(edge.to, [...path, byId.get(edge.to)!], [...usedEdges, edge]);
    }
  };
  for (const node of nodes.filter((item) => item.kind === "application" || item.kind === "screen")) visit(node.id, [node], []);
  return results;
}
