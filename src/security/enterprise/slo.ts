export interface SloJob {
  status: "completed" | "failed" | "dead" | "queued";
  queueWaitMs: number;
  technicalFailure?: boolean;
}

export interface SloSnapshot {
  total: number;
  successRate: number;
  queueWaitP95Ms: number;
  unknownCoverage: number;
  crossTenantViolations: number;
  alerts: string[];
}

export function evaluateSlo(jobs: SloJob[], unknownCoverage: number, crossTenantViolations: number, thresholds: { minimumSuccessRate?: number; maximumQueueWaitP95Ms?: number } = {}): SloSnapshot {
  const finished = jobs.filter((job) => job.status !== "queued");
  const successful = finished.filter((job) => job.status === "completed" && !job.technicalFailure).length;
  const successRate = finished.length ? successful / finished.length : 1;
  const waits = jobs.map((job) => job.queueWaitMs).sort((a, b) => a - b);
  const queueWaitP95Ms = waits.length ? waits[Math.min(waits.length - 1, Math.floor(waits.length * 0.95))]! : 0;
  const minimum = thresholds.minimumSuccessRate ?? 0.95;
  const maximumWait = thresholds.maximumQueueWaitP95Ms ?? 300_000;
  const alerts: string[] = [];
  if (successRate < minimum) alerts.push(`job success rate ${successRate} below ${minimum}`);
  if (queueWaitP95Ms > maximumWait) alerts.push(`queue wait p95 ${queueWaitP95Ms}ms above ${maximumWait}ms`);
  if (unknownCoverage > 0) alerts.push(`${unknownCoverage} unknown coverage items`);
  if (crossTenantViolations > 0) alerts.push(`${crossTenantViolations} cross-tenant violations`);
  return { total: jobs.length, successRate: Math.round(successRate * 1000) / 1000, queueWaitP95Ms, unknownCoverage, crossTenantViolations, alerts };
}
