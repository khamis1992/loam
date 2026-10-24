/**
 * Dynamic confirmation sandbox. This build is static-only: the sandbox never
 * runs, there is no host-shell fallback, and every dynamic request reports why.
 */
export interface SandboxProbe { available: boolean; blocker: string }

export const DYNAMIC_BLOCKER = "dynamic confirmation is disabled in this build (audit.dynamic=off); no container runtime is used";

export function probeSandbox(): SandboxProbe {
  return { available: false, blocker: DYNAMIC_BLOCKER };
}

export interface SandboxRunResult { available: false; blocker: string }

export function runInSandbox(_command: string): SandboxRunResult {
  return { available: false, blocker: DYNAMIC_BLOCKER };
}
