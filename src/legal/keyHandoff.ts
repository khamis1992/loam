/**
 * Server side of the matters-key handoff (Design decision LD-8).
 *
 * The server runs in an Electron utility process (electron/main.cjs:255
 * `utilityProcess.fork`), which exposes `process.parentPort`. At start the
 * server ASKS for the key, so no message can be lost to a listener that is not
 * yet attached; main (electron/legal-key.cjs) answers with the DPAPI-unwrapped
 * key. Outside Electron (start-web.bat, tests) there is no parentPort: the
 * matters store stays locked and every matters call fails closed.
 */
import { setMattersKey } from "./crypto.js";

export const KEY_REQUEST = "loam:legal-key-request";
export const KEY_RESPONSE = "loam:legal-key";

interface ParentPortLike {
  on(event: "message", listener: (e: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

export function parentPortOf(proc: NodeJS.Process): ParentPortLike | null {
  const port = (proc as unknown as { parentPort?: ParentPortLike }).parentPort;
  return port && typeof port.on === "function" && typeof port.postMessage === "function" ? port : null;
}

/** Returns true when a parent port exists and the request was sent. */
export function requestMattersKey(port: ParentPortLike | null, onReady?: () => void): boolean {
  if (!port) return false;
  port.on("message", (e) => {
    const d = e.data as { type?: unknown; key?: unknown } | null;
    if (!d || d.type !== KEY_RESPONSE || typeof d.key !== "string" || !/^[0-9a-f]{64}$/.test(d.key)) return;
    setMattersKey(Buffer.from(d.key, "hex"));
    onReady?.();
  });
  port.postMessage({ type: KEY_REQUEST });
  return true;
}
