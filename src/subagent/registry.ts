import type { SubagentProvider, SubagentStartOptions, SubagentRunHandle } from "./types.js";
import { Semaphore } from "./semaphore.js";

/** Default bound on concurrently running child subagents. */
export const DEFAULT_MAX_CONCURRENT_CHILDREN = 4;

/** Named provider registry plus the process-wide child concurrency bound.
 *  One process-wide instance is shared by the delegate_task tool so providers
 *  (and their limits) are configured once. */
export class SubagentRegistry {
  private readonly providers = new Map<string, SubagentProvider>();
  private children: Semaphore;

  constructor(maxConcurrentChildren: number = DEFAULT_MAX_CONCURRENT_CHILDREN) {
    this.children = new Semaphore(maxConcurrentChildren);
  }

  register(name: string, provider: SubagentProvider): void {
    if (this.providers.has(name)) throw new Error(`subagent provider already registered: ${name}`);
    this.providers.set(name, provider);
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  get(name: string): SubagentProvider | undefined {
    return this.providers.get(name);
  }

  names(): string[] {
    return [...this.providers.keys()].sort();
  }

  /** Current bound on concurrently running children. */
  get maxConcurrentChildren(): number {
    return this.children.max;
  }

  /** Update the concurrency bound (configuration change). */
  setMaxConcurrentChildren(limit: number): void {
    this.children.setLimit(limit);
  }

  /** Reserve one child slot. The returned function releases it. */
  acquireChild(): Promise<() => void> {
    return this.children.acquire();
  }

  async start(opts: SubagentStartOptions): Promise<SubagentRunHandle> {
    const provider = this.providers.get(opts.provider);
    if (!provider) throw new Error(`unknown subagent provider: ${opts.provider}`);
    return provider.start(opts);
  }
}

export const registry = new SubagentRegistry();
