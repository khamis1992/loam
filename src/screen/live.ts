import { log } from "../log.js";
import { captureScreen, type CaptureResult } from "./capture.js";

export interface LiveFrame extends CaptureResult {
  index: number;
}

export interface ScreenLiveOptions {
  dir: string;
  fps: number;
  quality: number;
  maxWidth: number;
}

export interface ScreenStatus {
  running: boolean;
  fps: number;
  frames: number;
  subscribers: number;
  lastAt: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  lastError: string | null;
}

/** Live screen broadcaster: captures frames on an interval and pushes them to SSE subscribers.
 *  Also keeps the latest frame so the agent can "look" without paying for a new capture. */
export class ScreenLive {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private frames = 0;
  private fps: number;
  private last: LiveFrame | null = null;
  private lastError: string | null = null;
  private readonly subs = new Set<(frame: LiveFrame) => void>();

  constructor(private readonly opts: ScreenLiveOptions) {
    this.fps = Math.min(Math.max(opts.fps, 0.2), 10);
  }

  get running(): boolean {
    return this.timer !== null;
  }

  get currentFps(): number {
    return this.fps;
  }

  status(): ScreenStatus {
    return {
      running: this.running,
      fps: this.fps,
      frames: this.frames,
      subscribers: this.subs.size,
      lastAt: this.last?.at ?? null,
      width: this.last?.width ?? null,
      height: this.last?.height ?? null,
      bytes: this.last?.bytes ?? null,
      lastError: this.lastError,
    };
  }

  latest(): LiveFrame | null {
    return this.last;
  }

  subscribe(listener: (frame: LiveFrame) => void): () => void {
    this.subs.add(listener);
    return () => this.subs.delete(listener);
  }

  start(fps?: number): void {
    if (fps !== undefined) this.fps = Math.min(Math.max(fps, 0.2), 10);
    if (this.timer) return;
    const interval = Math.max(100, Math.round(1000 / this.fps));
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref?.();
    log.info(`screen live: started at ${this.fps} fps`);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info("screen live: stopped");
    }
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const frame = await captureScreen({
        dir: this.opts.dir,
        format: "jpg",
        quality: this.opts.quality,
        maxWidth: this.opts.maxWidth,
        name: "live",
      });
      const live: LiveFrame = { ...frame, index: ++this.frames };
      this.last = live;
      this.lastError = null;
      for (const sub of this.subs) {
        try {
          sub(live);
        } catch {
          /* ignore subscriber errors */
        }
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      if (this.frames === 0) log.warn(`screen live capture failed: ${this.lastError}`);
    } finally {
      this.busy = false;
    }
  }
}
