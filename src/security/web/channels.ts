export type ApiChannel = "REST" | "GraphQL" | "WebSocket" | "gRPC" | "HTTP2" | "HTTP3" | "WebTransport";

export interface ChannelObservation {
  operation: string;
  channel: ApiChannel;
  authenticated: boolean;
  authorized: boolean;
  status: number;
  evidenceIds: string[];
}

export function compareChannelControls(observations: ChannelObservation[]): { operation: string; status: "pass" | "finding" | "inconclusive"; detail: string; evidenceIds: string[] }[] {
  const operations = new Map<string, ChannelObservation[]>();
  for (const observation of observations) {
    const list = operations.get(observation.operation) ?? [];
    list.push(observation);
    operations.set(observation.operation, list);
  }
  return [...operations].map(([operation, entries]) => {
    const evidenceIds = [...new Set(entries.flatMap((entry) => entry.evidenceIds))];
    if (entries.length < 2 || entries.some((entry) => !entry.evidenceIds.length)) return { operation, status: "inconclusive" as const, detail: "not all alternate channels have evidence", evidenceIds };
    const mismatch = entries.some((entry) => entry.authenticated !== entries[0]!.authenticated || entry.authorized !== entries[0]!.authorized);
    if (mismatch) return { operation, status: "finding" as const, detail: "authentication or authorization differs across channels", evidenceIds };
    return { operation, status: "pass" as const, detail: "all observed channels enforce the same access decision", evidenceIds };
  });
}
