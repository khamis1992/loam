let runs = 0;

export function adjustForeground(delta: number): void {
  runs = Math.max(0, runs + delta);
}

export function foregroundRuns(): number {
  return runs;
}

export function isIdle(): boolean {
  return runs === 0;
}
