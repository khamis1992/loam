/**
 * Attack-surface graph (Supremacy M3.3): a JSON tree of discovered assets,
 * paths, techs and findings. The planner uses it to propose targeted next steps;
 * the report renders it as a navigable tree.
 */

export interface SurfaceNode {
  id: string;
  kind: "host" | "subdomain" | "path" | "tech" | "finding";
  label: string;
  meta?: Record<string, string>;
  children: SurfaceNode[];
}

export interface SurfaceGraph {
  root: SurfaceNode;
  stats: { hosts: number; paths: number; techs: number; findings: number };
}

let seq = 0;
const nodeId = (kind: SurfaceNode["kind"], label: string): string => `${kind}-${label.replace(/[^\w.-]/g, "_")}-${++seq}`;

function findOrCreate(parent: SurfaceNode, kind: SurfaceNode["kind"], label: string, meta?: Record<string, string>): SurfaceNode {
  const existing = parent.children.find((c) => c.kind === kind && c.label === label);
  if (existing) return existing;
  const node: SurfaceNode = { id: nodeId(kind, label), kind, label, ...(meta ? { meta } : {}), children: [] };
  parent.children.push(node);
  return node;
}

/**
 * Build the attack-surface graph from recon + findings data. This is a pure
 * function — it never touches the network.
 */
export function buildSurfaceGraph(input: {
  target: string;
  assets: Array<{ target: string; webPaths: string[]; techFingerprint: string[]; status?: number; title?: string; server?: string }>;
  subdomains?: Array<{ subdomain: string; source: string }>;
  findings?: Array<{ check: string; target: string; title: string; severity: string }>;
}): SurfaceGraph {
  const root: SurfaceNode = { id: "root", kind: "host", label: input.target, children: [] };
  const stats = { hosts: 0, paths: 0, techs: 0, findings: 0 };

  for (const asset of input.assets) {
    const hostNode = findOrCreate(root, "host", asset.target, { ...(asset.status !== undefined ? { status: String(asset.status) } : {}), ...(asset.title ? { title: asset.title } : {}), ...(asset.server ? { server: asset.server } : {}) });
    stats.hosts++;
    for (const tech of asset.techFingerprint) {
      findOrCreate(hostNode, "tech", tech);
      stats.techs++;
    }
    for (const path of asset.webPaths) {
      findOrCreate(hostNode, "path", path);
      stats.paths++;
    }
  }

  for (const sub of input.subdomains ?? []) {
    findOrCreate(root, "subdomain", sub.subdomain, { source: sub.source });
    stats.hosts++;
  }

  for (const finding of input.findings ?? []) {
    const hostLabel = finding.target.replace(/^https?:\/\//, "").split("/")[0]!;
    const hostNode = root.children.find((c) => c.label.includes(hostLabel)) ?? root;
    findOrCreate(hostNode, "finding", `[${finding.severity}] ${finding.title}`, { check: finding.check });
    stats.findings++;
  }

  return { root, stats };
}

/** Render the graph as a Markdown tree for the report. */
export function renderSurfaceMarkdown(graph: SurfaceGraph): string {
  const lines: string[] = ["## Attack Surface", "", `- ${graph.stats.hosts} hosts · ${graph.stats.paths} paths · ${graph.stats.techs} techs · ${graph.stats.findings} findings`, ""];
  const walk = (node: SurfaceNode, depth: number): void => {
    const indent = "  ".repeat(depth);
    const icon = node.kind === "finding" ? "🔴" : node.kind === "tech" ? "⚙️" : node.kind === "path" ? "📄" : node.kind === "subdomain" ? "🌐" : "🏠";
    const meta = node.meta ? ` (${Object.entries(node.meta).map(([k, v]) => `${k}: ${v}`).join(", ")})` : "";
    lines.push(`${indent}- ${icon} ${node.label}${meta}`);
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(graph.root, 0);
  return lines.join("\n");
}
