import type { ServerResponse } from 'node:http';

/** Transport-only comments: never task progress or completion evidence. */
export function startSseHeartbeat(res: ServerResponse, intervalMs = 15_000): () => void {
  const stop = () => {
    clearInterval(timer);
    res.off('close', stop);
    res.off('finish', stop);
  };
  const timer = setInterval(() => {
    if (res.destroyed || res.writableEnded) { stop(); return; }
    if (!res.writableNeedDrain) res.write(': keepalive\n\n');
  }, intervalMs);
  timer.unref();
  res.once('close', stop);
  res.once('finish', stop);
  res.flushHeaders();
  return stop;
}
