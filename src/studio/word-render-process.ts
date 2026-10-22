import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';

/** Export completion is distinct from COM teardown. Only the helper's atomic
 * completion marker permits recovery from a stalled/failed teardown. */
export function runWordRenderProcess(command: string, args: string[], output: string,
  options: { timeout?: number; cleanupGrace?: number; pollInterval?: number } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false, checking = false, exportedAt = 0;
    const marker = output + '.ready';
    const child = execFile(command, args, { windowsHide: true, timeout: options.timeout ?? 120_000, maxBuffer: 128_000 }, async error => {
      if (finished) return;
      if (!error || await fs.access(marker).then(() => true, () => false)) finish();
      else finish(error);
    });
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true; clearInterval(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setInterval(async () => {
      if (finished || checking) return;
      checking = true;
      try {
        await fs.access(marker);
        if (!exportedAt) exportedAt = Date.now();
        if (!finished && Date.now() - exportedAt >= (options.cleanupGrace ?? 3000)) {
          // The PDF is complete. Bound only teardown, not document rendering.
          // Word itself is cleaned up by its recorded PID + start time owner.
          child.kill();
        }
      } catch { /* Export has not completed. Keep the full rendering deadline. */ }
      finally { checking = false; }
    }, options.pollInterval ?? 200);
  });
}
