/**
 * Companion-to-companion collaboration (frontier stage 5, section 15).
 *
 * A companion can delegate part of its work to ANOTHER companion: the delegate
 * task runs under the target companion's identity (its model, instructions,
 * memory and services) and lands in its conversation; the delegating companion
 * stays the single interface to the user and can poll the result. Project
 * handover moves a project's tasks to another companion and transfers relevant
 * personal memory as explicit context.
 */
import { log } from "../log.js";

export interface DelegationRequest {
  toAgentId: string;
  brief: string;
  title?: string;
  mode?: string;
  workMode?: string;
  fromAgentId: string;
  fromTaskId?: string;
}

export interface DelegationHandle {
  taskId: string;
  toAgentId: string;
  queued: boolean;
  error?: string;
}

/** Wired by index.ts so tools can start runs without importing the server loop. */
let delegationRunner: ((req: DelegationRequest) => Promise<{ taskId: string; queued: boolean; error?: string }>) | undefined;

export function setDelegationRunner(runner?: typeof delegationRunner): void {
  delegationRunner = runner;
}

export function delegationRunnerActive(): boolean {
  return delegationRunner !== undefined;
}

export async function delegate(req: DelegationRequest): Promise<DelegationHandle | { error: string }> {
  if (!delegationRunner) return { error: "محرك التفويض غير متاح في هذه الجولة — أبلغ المستخدم بإنشاء المهمة يدويًا لدى الرفيق الآخر" };
  try {
    const res = await delegationRunner(req);
    return { taskId: res.taskId, toAgentId: req.toAgentId, queued: res.queued, ...(res.error ? { error: res.error } : {}) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`delegation failed: ${message}`);
    return { error: `فشل بدء تشغيل المهمة لدى الرفيق: ${message}` };
  }
}
