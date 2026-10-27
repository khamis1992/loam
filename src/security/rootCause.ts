import { createHash } from "node:crypto";

export interface RootCauseFinding {
  ruleId: string;
  target: string;
  title: string;
  component?: string;
  rootCause?: string;
  evidenceIds?: string[];
}

export interface RootCauseGroup {
  id: string;
  ruleId: string;
  component: string;
  rootCause: string;
  findings: RootCauseFinding[];
  evidenceIds: string[];
}

export function groupByRootCause(findings: RootCauseFinding[]): RootCauseGroup[] {
  const groups = new Map<string, RootCauseGroup>();
  for (const finding of findings) {
    const component = finding.component ?? finding.target;
    const rootCause = finding.rootCause?.trim() || finding.ruleId;
    const key = `${finding.ruleId}\n${component}\n${rootCause}`;
    const group = groups.get(key) ?? { id: createHash("sha256").update(key).digest("hex").slice(0, 24), ruleId: finding.ruleId, component, rootCause, findings: [], evidenceIds: [] };
    group.findings.push(finding);
    group.evidenceIds = [...new Set([...group.evidenceIds, ...(finding.evidenceIds ?? [])])];
    groups.set(key, group);
  }
  return [...groups.values()];
}
