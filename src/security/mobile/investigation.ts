import type { MobileEngagement, MobileFinding } from "./engagement.js";
import type { TimelineEvent } from "./evidenceTimeline.js";

export interface InvestigationFinding {
  finding: MobileFinding;
  timeline: Array<Pick<TimelineEvent, "id" | "seq" | "at" | "kind" | "summary" | "sha256">>;
  replayEligible: boolean;
}

export function buildInvestigation(state: MobileEngagement, events: TimelineEvent[]): { engagementId: string; stage: string; findings: InvestigationFinding[]; unlinkedEvidence: number } {
  const linked = new Set<string>();
  const findings = state.findings.map((finding) => {
    const timeline = events.filter((event) => event.relatedFindingIds.includes(finding.id));
    for (const event of timeline) linked.add(event.id);
    return {
      finding,
      timeline: timeline.map(({ id, seq, at, kind, summary, sha256 }) => ({ id, seq, at, kind, summary, sha256 })),
      replayEligible: timeline.some((event) => event.kind === "request"),
    };
  });
  return { engagementId: state.id, stage: state.stage, findings, unlinkedEvidence: events.filter((event) => !linked.has(event.id)).length };
}
