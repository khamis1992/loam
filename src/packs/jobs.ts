import { randomUUID } from "node:crypto";

export interface PackJob {
  id: string;
  packId: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  path?: string;
  error?: string;
}

const jobs = new Map<string, PackJob>();

export function createPackJob(packId: string): PackJob {
  const job: PackJob = { id: randomUUID(), packId, status: "queued" };
  jobs.set(job.id, job);
  return job;
}

export function getPackJob(id: string): PackJob | undefined {
  return jobs.get(id);
}

export function updatePackJob(id: string, patch: Partial<Omit<PackJob, "id" | "packId">>): PackJob {
  const job = jobs.get(id);
  if (!job) throw new Error("pack job not found");
  if (job.status === "done" || job.status === "failed" || job.status === "cancelled") throw new Error("pack job is already final");
  Object.assign(job, patch);
  return job;
}

export function cancelPackJob(id: string): PackJob {
  const job = jobs.get(id);
  if (!job) throw new Error("pack job not found");
  if (job.status === "done" || job.status === "failed" || job.status === "cancelled") return job;
  job.status = "cancelled";
  return job;
}
