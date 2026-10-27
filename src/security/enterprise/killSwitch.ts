import fs from "node:fs";
import path from "node:path";

export interface SharedKillState {
  engaged: boolean;
  revision: number;
  actorId: string;
  at: string;
  expiresAt?: string;
}

export class SharedKillSwitch {
  private readonly file: string;
  private readonly listeners = new Set<() => void>();

  constructor(root: string) {
    this.file = path.join(root, "kill-switch.json");
    fs.mkdirSync(root, { recursive: true });
  }

  read(now = Date.now()): SharedKillState {
    try {
      const state = JSON.parse(fs.readFileSync(this.file, "utf8")) as SharedKillState;
      if (state.expiresAt && Date.parse(state.expiresAt) <= now) return { ...state, engaged: false };
      return state;
    } catch {
      const corrupted = fs.existsSync(this.file);
      return { engaged: corrupted, revision: 0, actorId: corrupted ? "integrity-failure" : "system", at: new Date(0).toISOString() };
    }
  }

  set(engaged: boolean, actorId: string, ttlSeconds?: number): SharedKillState {
    if (!actorId.trim()) throw new Error("kill-switch actor required");
    const current = this.read();
    const state: SharedKillState = {
      engaged,
      revision: current.revision + 1,
      actorId,
      at: new Date().toISOString(),
      ...(engaged && ttlSeconds ? { expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() } : {}),
    };
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    if (engaged) for (const listener of this.listeners) listener();
    return state;
  }

  subscription(): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    if (this.read().engaged) controller.abort();
    const listener = (): void => controller.abort();
    this.listeners.add(listener);
    return { signal: controller.signal, dispose: () => this.listeners.delete(listener) };
  }
}
