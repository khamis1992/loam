/**
 * Dynamic confirmation sandbox. Default is static-only. With `audit.dynamic`
 * enabled, the bounded local fuzz executor (jazzer via argv, no shell, wall-
 * clock and RSS caps) becomes available and its crash artifacts count as
 * dynamic proof. There is still no container runtime and no host-shell
 * fallback: arbitrary command execution stays refused in every mode.
 */
export interface SandboxProbe { available: boolean; blocker: string }

export const DYNAMIC_BLOCKER = "dynamic confirmation is disabled (audit.dynamic=off); no container runtime is used";

export function probeSandbox(dynamic = false): SandboxProbe {
  return dynamic
    ? { available: true, blocker: "" }
    : { available: false, blocker: DYNAMIC_BLOCKER };
}

export interface SandboxRunResult { available: false; blocker: string }

export function runInSandbox(_command: string): SandboxRunResult {
  return { available: false, blocker: "arbitrary command execution is refused in every mode; only the bounded fuzz executor runs" };
}
