/** Service-failure trigger (16): probe a dependency on an interval and fire the
 *  companion's routine on an up→down transition (debounced, one shot per episode). */
export interface ServiceWatchDeps {
  probe: () => Promise<boolean>;
  run: (o: { prompt: string; scheduleId: string; agentId?: string; workMode?: string }) => Promise<string>;
  watches: () => Array<{ id: string; prompt: string; agentId?: string; workMode?: string }>;
  intervalMs?: number;
  coolOffMs?: number;
}

export function startServiceWatch(deps: ServiceWatch_depsAlias): () => void {
  let lastUp = true;
  let lastFire = 0;
  const timer = setInterval(() => {
    void (async () => {
      const up = await deps.probe().catch(() => false);
      const now = Date.now();
      if (lastUp && !up && now - lastFire > (deps.coolOffMs ?? 10 * 60_000)) {
        lastFire = now;
        for (const w of deps.watches()) {
          void deps.run({ prompt: w.prompt, scheduleId: w.id, ...(w.agentId ? { agentId: w.agentId } : {}), ...(w.workMode ? { workMode: w.workMode } : {}) }).catch(() => undefined);
        }
      }
      lastUp = up;
    })();
  }, deps.intervalMs ?? 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
type ServiceWatch_depsAlias = ServiceWatchDeps;
