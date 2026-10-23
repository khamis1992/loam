/** Shared in-memory blob store for the §8.1 upload contract.
 *  PUT /blob/:id writes here; the socket layer reads blobs when attaching
 *  files to a Loam task workspace.
 *
 *  Bounded (J6): blobs are whole uploads held in RAM until the task picks them
 *  up, so the store keeps a byte ceiling plus an entry cap and drops the
 *  least-recently-stored blob first. `deleteBlob` remains the explicit release
 *  path used once a blob has been attached.
 */
import { BoundedMap } from "../memory/cache.js";
import { registerCacheStats } from "../memory/stats.js";

/** Hard ceiling on retained upload bytes (64 MB) — matches the per-upload cap. */
export const BLOB_STORE_MAX_BYTES = 64 * 1024 * 1024;
/** Hard ceiling on the number of retained blobs (one upload each). */
export const BLOB_STORE_MAX_ENTRIES = 64;

let retainedBytes = 0;
const blobs = new BoundedMap<string, Buffer>(BLOB_STORE_MAX_ENTRIES, "protocol-blobs", (_id, data) => {
  retainedBytes -= data.byteLength;
});

registerCacheStats("protocol-blobs", () => ({
  name: "protocol-blobs",
  size: blobs.size,
  capacity: BLOB_STORE_MAX_ENTRIES,
  bytes: retainedBytes,
  maxBytes: BLOB_STORE_MAX_BYTES,
}));

function evictUntilBytesFit(protect: string): void {
  while (retainedBytes > BLOB_STORE_MAX_BYTES && blobs.size > 1) {
    const oldest = blobs.keys().next();
    if (oldest.done || oldest.value === protect) return;
    const data = blobs.get(oldest.value);
    blobs.delete(oldest.value);
    if (data) retainedBytes -= data.byteLength;
  }
}

export function storeBlob(id: string, data: Buffer): void {
  const previous = blobs.get(id);
  if (previous) retainedBytes -= previous.byteLength;
  retainedBytes += data.byteLength;
  blobs.set(id, data);
  evictUntilBytesFit(id);
}

export function getBlob(id: string): Buffer | undefined {
  return blobs.get(id);
}

export function hasBlob(id: string): boolean {
  return blobs.has(id);
}

export function deleteBlob(id: string): boolean {
  const data = blobs.get(id);
  const removed = blobs.delete(id);
  if (removed && data) retainedBytes -= data.byteLength;
  return removed;
}

/** Test/teardown helper: drop every retained blob. */
export function clearBlobs(): void {
  blobs.clear();
  retainedBytes = 0;
}
